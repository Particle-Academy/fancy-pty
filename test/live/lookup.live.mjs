// LIVE, Windows only: which program a name actually starts.
//
// The claim is mostly negative ("this file does not run"), so the run is worth
// nothing unless the instrument can see a planted program run. Every battery
// opens with that control, and the whole file was run red against 0.3.0.
//
// THE TRAP THAT MAKES THIS FILE DRIVE THE HELPER ITSELF: `open()` hands the
// helper the host's real environment and the host's real cwd. An agent shell on
// the machine this was written on sets NoDefaultCurrentDirectoryInExePath=1,
// which closes one of these cases by accident, so a check through `open()` is
// green on vulnerable code there. Here the helper's environment, cwd and even
// its directory are chosen per case, and the variable is removed and checked.
//
// A plant is cmdline-echo.rs under another name. It appends one line to a file
// and exits: nothing else.
//
//   FANCY_PTY_LOOKUP_HELPER=<exe>  run against that helper instead of bin/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { encodeSpawn, frame, FrameDecoder, helperPath } from "../../dist/index.js";

if (process.platform !== "win32") {
    console.log("lookup.live: Windows only, nothing to run here");
    process.exit(0);
}

const VAR = "NoDefaultCurrentDirectoryInExePath";
const T_SPAWN = 0x00;
const T_KILL = 0x03;
const F_DATA = 0x81;
const F_EXIT = 0x82;
const F_ERROR = 0x83;
const F_PID = 0x84;

let failures = 0;
let total = 0;
const ok = (cond, what) => {
    total++;
    console.log(`  ${cond ? "ok  " : "FAIL"} ${what}`);
    if (!cond) failures++;
};

const helperUnderTest = process.env.FANCY_PTY_LOOKUP_HELPER || helperPath();
const q = '"';

console.log(`\nfancy-pty lookup suite -- helper under test: ${helperUnderTest}`);
console.log(`ambient ${VAR} = ${JSON.stringify(process.env[VAR] ?? null)} (removed from this whole process tree)\n`);
// Everything below inherits this, so a dev machine that sets the variable runs in
// the same condition as a runner that does not. Also covered per case by baseEnv.
for (const k of Object.keys(process.env)) if (k.toLowerCase() === VAR.toLowerCase()) delete process.env[k];

const sameFile = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const isAbsoluteEntry = (e) => /^[A-Za-z]:[\\/]/.test(e) || /^[\\/]{2}/.test(e);

/** The host's environment, minus the variable and any case of PATH. */
function baseEnv() {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (k.toLowerCase() === VAR.toLowerCase() || k.toLowerCase() === "path") continue;
        env[k] = v;
    }
    return env;
}

const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "fancy-pty-lookup-")));
try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dir = (...p) => {
        const d = path.join(root, ...p);
        mkdirSync(d, { recursive: true });
        return d;
    };
    const build = (source, out) =>
        execFileSync(
            "rustc",
            ["-C", "target-feature=+crt-static", "-C", "debuginfo=0", path.join(here, "fixtures", source), "-o", out],
            { stdio: "pipe", windowsHide: true, cwd: dir("build") },
        );

    const fixture = path.join(dir("fixture"), "echo.exe");
    const imageTool = path.join(dir("fixture"), "image-of.exe");
    build("cmdline-echo.rs", fixture);
    build("image-of.rs", imageTool);

    const imageOf = (pid) => {
        const r = spawnSync(imageTool, [String(pid)], { encoding: "utf8", windowsHide: true, cwd: root });
        return r.status === 0 ? r.stdout.trim() : null;
    };

    const plantExe = (d, name) => copyFileSync(fixture, path.join(d, name));
    const batchBody = (who, code = 0) =>
        `@echo off\r\n>>"%FANCY_PTY_ECHO_OUT%.batch" echo ${who} zero=[%0] args=[%*]\r\nexit /b ${code}\r\n`;

    const clean = dir("clean");
    const hostPlants = dir("host plants");
    const optionPlants = dir("option plants");
    const beside = dir("helper with plants");
    const plain = dir("helper plain");
    const onPath = dir("on path");
    const spacedPath = dir("R&D tools (x86)");

    const helperPlain = path.join(plain, "fancy-pty-helper.exe");
    const helperBeside = path.join(beside, "fancy-pty-helper.exe");
    copyFileSync(helperUnderTest, helperPlain);
    copyFileSync(helperUnderTest, helperBeside);

    for (const name of ["cmd.exe", "powershell.exe", "pwsh.exe", "fplcwdonly.exe"]) plantExe(hostPlants, name);
    for (const name of ["cmd.exe", "powershell.exe", "fplbesideonly.exe"]) plantExe(beside, name);
    for (const name of ["cmd.exe", "powershell.exe", "fploptiononly.exe"]) plantExe(optionPlants, name);
    plantExe(dir("host plants", "sub"), "tool.exe");
    plantExe(hostPlants, "tool.exe");
    plantExe(onPath, "fplonpath.exe");
    plantExe(dir("on path", "sub"), "fplpathsub.exe");

    // Batch files. `fplbatch` is on PATH and also planted everywhere it must
    // not come from.
    writeFileSync(path.join(onPath, "fplbatch.cmd"), batchBody("GOOD-PATH", 7));
    writeFileSync(path.join(spacedPath, "fplspaced.cmd"), batchBody("GOOD-SPACED"));
    // Takes about a second before it does anything. A script's speed must not
    // decide the verdict, and a fast machine hides it if it does: see check 7a.
    writeFileSync(
        path.join(onPath, "fplslow.cmd"),
        batchBody("GOOD-SLOW", 7).replace("@echo off\r\n", "@echo off\r\n%SystemRoot%\\System32\\ping.exe -n 2 127.0.0.1 >nul\r\n"),
    );
    writeFileSync(path.join(hostPlants, "fplbatch.cmd"), batchBody("PLANT-HOST"));
    writeFileSync(path.join(beside, "fplbatch.cmd"), batchBody("PLANT-BESIDE"));
    writeFileSync(path.join(optionPlants, "fplbatch.cmd"), batchBody("PLANT-OPTION"));
    writeFileSync(path.join(optionPlants, "fplspaced.cmd"), batchBody("PLANT-OPTION"));
    writeFileSync(path.join(hostPlants, "rel.cmd"), batchBody("GOOD-HOST-REL"));
    writeFileSync(path.join(optionPlants, "rel.cmd"), batchBody("PLANT-OPTION-REL"));
    const absBatch = path.join(onPath, "fplbatch.cmd");
    const spacedBatch = path.join(spacedPath, "fplspaced.cmd");

    const ambientPath = (process.env.PATH ?? "").split(";").filter(isAbsoluteEntry);
    const pathOf = (...first) => [...first, ...ambientPath].join(";");
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const realCmd = path.join(systemRoot, "System32", "cmd.exe");
    const realPs = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

    let runs = 0;
    const units = (a) => String.fromCharCode(...a);
    const decodeRecord = (r) => ({ exe: units(r.exe), raw: units(r.raw), argv: r.argv.map(units) });

    /** One helper, one SPAWN, and what really happened. */
    async function run(o) {
        const out = path.join(root, `out-${runs++}.jsonl`);
        const helperEnv = baseEnv();
        helperEnv.PATH = o.helperPathVar ?? pathOf();
        if (o.helperVarSet) helperEnv[VAR] = "1";
        if (o.helperPathVar === null) delete helperEnv.PATH;
        const childEnv = o.childEnvExact ?? { ...baseEnv(), PATH: o.childPathVar ?? pathOf(onPath), FANCY_PTY_ECHO_OUT: out };

        const child = spawn(o.helper ?? helperPlain, [], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            detached: true,
            cwd: o.hostCwd ?? clean,
            env: helperEnv,
        });
        const result = { pid: null, image: null, errors: [], code: undefined, text: "" };
        const heldOpen = o.argv.some((a) => a === "/k" || a === "-NoExit");
        const dec = new FrameDecoder();
        child.stdin.on("error", () => {});
        child.stderr.on("data", () => {});

        const exited = new Promise((resolve) => child.on("close", resolve));
        child.stdout.on("data", (chunk) => {
            for (const f of dec.push(chunk)) {
                if (f.kind === F_PID) {
                    result.pid = f.payload.readUInt32LE(0);
                    // Asked before anything else, while the command still lives.
                    result.image = imageOf(result.pid);
                    // ONLY a shell held open on purpose is ended here. Anything
                    // else gets to finish: a kill at this point lands while a
                    // batch file is still starting, and it dies with exit 1 and
                    // no output, which reads exactly like one that cannot start.
                    if (heldOpen) child.stdin.write(frame(T_KILL, Buffer.alloc(0)));
                } else if (f.kind === F_EXIT) result.code = f.payload.readUInt32LE(0);
                else if (f.kind === F_ERROR) result.errors.push(f.payload.toString("utf8"));
                else if (f.kind === F_DATA) result.text += f.payload.toString("utf8");
            }
        });

        child.stdin.write(
            frame(
                T_SPAWN,
                encodeSpawn({
                    argv: o.argv,
                    cwd: o.cwd,
                    cols: 120,
                    rows: 30,
                    env: childEnv,
                    windowsVerbatimArguments: o.verbatim || undefined,
                }),
            ),
        );
        const timer = setTimeout(() => {
            result.timeout = true;
            child.kill();
        }, 20000);
        await exited;
        clearTimeout(timer);
        if (result.timeout) ok(false, `${JSON.stringify(o.argv)} was still running after 20 s and was ended`);

        result.records = existsSync(out)
            ? readFileSync(out, "utf8")
                  .split("\n")
                  .filter(Boolean)
                  .map((l) => decodeRecord(JSON.parse(l)))
            : [];
        result.batch = existsSync(`${out}.batch`)
            ? readFileSync(`${out}.batch`, "utf8").trim().split(/\r?\n/)
            : [];
        result.ran = result.records[0]?.exe ?? result.image;
        return result;
    }

    const said = (r) => r.records[0]?.exe ?? r.image ?? r.errors.join("; ").slice(0, 100) ?? "nothing";
    const expectReal = (r, real, what) =>
        ok(r.records.length === 0 && sameFile(r.image, real), `${what}: the real one ran (${said(r)})`);
    const expectNoPlant = (r, what) => ok(r.records.length === 0, `${what}: no plant ran (${said(r)})`);
    const expectStart = (r, exe, what) =>
        ok(r.records.length === 1 && sameFile(r.records[0].exe, exe), `${what} (${said(r)})`);
    const expectMissing = (r, what) =>
        ok(
            r.records.length === 0 && r.pid === null && r.errors.length > 0 && r.code === 1,
            `${what}: reported as an error, nothing ran (${r.errors.join("; ").slice(0, 70) || said(r)})`,
        );
    const batchWas = (r, who) => r.batch.length === 1 && r.batch[0].startsWith(`${who} `);

    // ------------------------------------------------- the instrument itself
    console.log("0. the instrument");
    const envCheck = baseEnv();
    const seen = spawnSync(process.execPath, ["-p", `process.env.${VAR} ?? "<unset>"`], {
        env: envCheck,
        encoding: "utf8",
        windowsHide: true,
    });
    ok(seen.stdout.trim() === "<unset>", `the helper environment has no ${VAR} (a child of it saw ${seen.stdout.trim()})`);
    ok(sameFile(imageOf(process.pid), realpathSync.native(process.execPath)), "image-of reads a known process correctly");
    const plantSelf = await run({ argv: [path.join(hostPlants, "cmd.exe")] });
    ok(
        plantSelf.records.length === 1 && sameFile(plantSelf.records[0].exe, path.join(hostPlants, "cmd.exe")),
        `a plant, started by its full path, runs and identifies itself (${said(plantSelf)})`,
    );

    const SHELLS = [
        { name: "cmd.exe", args: ["/k"], real: realCmd },
        { name: "cmd", args: ["/k"], real: realCmd },
        { name: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NoExit"], real: realPs },
        { name: "powershell", args: ["-NoLogo", "-NoProfile", "-NoExit"], real: realPs },
    ];

    for (const verbatim of [false, true]) {
        const mode = verbatim ? "verbatim" : "default";
        console.log(`\n--- ${mode} mode ---`);
        const go = (o) => run({ ...o, verbatim });

        // -------------------------------------------------------- the host's cwd
        console.log("1. a same-named file in the host's current directory");
        for (const s of SHELLS) {
            const control = await go({ argv: [s.name, ...s.args] });
            expectReal(control, s.real, `control, clean cwd, ${s.name}`);
            const r = await go({ argv: [s.name, ...s.args], hostCwd: hostPlants });
            expectReal(r, s.real, `plant in host cwd, ${s.name}`);
        }
        expectNoPlant(await go({ argv: ["pwsh.exe", "-NoLogo", "-NoProfile", "-NoExit"], hostCwd: hostPlants }), "plant in host cwd, pwsh.exe");
        expectMissing(await go({ argv: ["fplcwdonly.exe"], hostCwd: hostPlants }), "a name found ONLY in the host cwd");

        // ------------------------------------------------------- beside the helper
        console.log("2. a same-named file beside the helper");
        for (const s of SHELLS) {
            const r = await go({ argv: [s.name, ...s.args], helper: helperBeside });
            expectReal(r, s.real, `plant beside helper, ${s.name}`);
        }
        expectMissing(await go({ argv: ["fplbesideonly.exe"], helper: helperBeside }), "a name found ONLY beside the helper");

        // ------------------------------------------------- relative PATH entries
        console.log("3. relative and empty PATH entries in the helper's PATH");
        const psArgs = ["powershell.exe", "-NoLogo", "-NoProfile", "-NoExit"];
        // With the variable SET: the cwd case is shut, so only PATH can reach it.
        for (const [label, entry] of [
            [".", "."],
            ["empty", ""],
            ["..\\host plants", "..\\host plants"],
        ]) {
            const r = await go({
                argv: psArgs,
                hostCwd: label === "..\\host plants" ? clean : hostPlants,
                helperVarSet: true,
                helperPathVar: [entry, ...ambientPath].join(";"),
            });
            expectReal(r, realPs, `${VAR} set, PATH starts ${JSON.stringify(entry)}`);
        }
        expectMissing(
            await go({ argv: ["fplcwdonly.exe"], hostCwd: hostPlants, helperVarSet: true, helperPathVar: pathOf(".") }),
            "unique name, only reachable through PATH=.",
        );
        expectMissing(
            await go({ argv: ["fplcwdonly.exe"], hostCwd: hostPlants, helperVarSet: true, helperPathVar: `;${ambientPath.join(";")}` }),
            "unique name, only reachable through an empty entry",
        );

        // ------------------------------------------------- absolute PATH entries
        console.log("4. absolute PATH entries still work");
        const inPath = path.join(onPath, "fplonpath.exe");
        const found = await go({ argv: ["fplonpath.exe", "--x"], helperPathVar: pathOf(onPath) });
        expectStart(found, inPath, "a unique name on an absolute PATH entry runs");
        ok(found.records[0]?.raw === "fplonpath.exe --x", `and argv[0] is unchanged on the command line (${found.records[0]?.raw})`);
        expectStart(await go({ argv: ["fplonpath"], helperPathVar: pathOf(onPath) }), inPath, ".exe is appended to a name with no extension");
        expectStart(await go({ argv: ["fplonpath.exe"], helperPathVar: pathOf(`${onPath}\\`) }), inPath, "an entry with a trailing backslash");
        expectStart(await go({ argv: ["fplonpath.exe"], helperPathVar: pathOf(onPath.replaceAll("\\", "/")) }), inPath, "an entry with forward slashes");
        expectMissing(
            await go({ argv: ["fplonpath.exe"], helperPathVar: pathOf(`${q}${onPath}${q}`) }),
            "a QUOTED entry is not an entry (same as CreateProcessW's own search)",
        );
        expectMissing(await go({ argv: ["fplonpath.exe"], helperPathVar: null }), "no PATH at all");
        expectReal(await go({ argv: ["cmd.exe", "/k"], helperPathVar: null }), realCmd, "no PATH at all, cmd.exe");
        // Not a statement that this is right. A separate decision, pinned so a
        // change to it is a visible one.
        expectMissing(
            await go({ argv: ["fplonpath.exe"], childPathVar: pathOf(onPath), helperPathVar: pathOf() }),
            "the env option's PATH still does not drive lookup",
        );

        // ------------------------------------------------------ the cwd option
        console.log("5. the cwd option is not searched");
        for (const s of SHELLS.slice(0, 2)) {
            expectReal(await go({ argv: [s.name, ...s.args], cwd: optionPlants }), s.real, `plant in cwd option, ${s.name}`);
        }
        expectMissing(await go({ argv: ["fploptiononly.exe"], cwd: optionPlants }), "a name found ONLY in the cwd option");

        // ---------------------------------------------------- explicit relative
        console.log("6. a directory part means what it says: the host's cwd, no search");
        const hostTool = path.join(hostPlants, "tool.exe");
        const subTool = path.join(hostPlants, "sub", "tool.exe");
        const rel = await go({ argv: [".\\tool.exe", "--x"], hostCwd: hostPlants });
        expectStart(rel, hostTool, ".\\tool.exe from the host cwd runs as asked");
        ok(rel.records[0]?.raw === ".\\tool.exe --x", `and argv[0] is unchanged on the command line (${rel.records[0]?.raw})`);
        expectStart(await go({ argv: ["./tool.exe"], hostCwd: hostPlants }), hostTool, "./tool.exe too");
        expectStart(await go({ argv: [".\\tool"], hostCwd: hostPlants }), hostTool, ".\\tool appends .exe");
        expectStart(await go({ argv: ["sub\\tool.exe"], hostCwd: hostPlants }), subTool, "sub\\tool.exe from the host cwd");
        expectStart(
            await go({ argv: [".\\tool.exe"], hostCwd: hostPlants, cwd: clean }),
            hostTool,
            ".\\tool.exe with a cwd option is still the host's",
        );
        expectMissing(await go({ argv: [".\\tool.exe"], hostCwd: clean, cwd: hostPlants }), ".\\tool.exe only in the cwd option");
        expectMissing(
            await go({ argv: ["sub\\fplpathsub.exe"], hostCwd: clean, helperPathVar: pathOf(onPath) }),
            "sub\\x.exe only under a PATH entry: a directory part is not searched",
        );
        expectStart(await go({ argv: [inPath], hostCwd: clean }), inPath, "an absolute path runs");

        // ------------------------------------------------------ batch files
        console.log("7. .cmd and .bat");
        const abs = await go({ argv: [absBatch, "a b", "c"], hostCwd: clean, helperPathVar: pathOf() });
        ok(batchWas(abs, "GOOD-PATH"), `an absolute .cmd runs (${abs.batch[0] ?? abs.errors.join("; ")})`);
        ok(abs.code === 7, `and its exit code comes back (${abs.code})`);
        ok(abs.records.length === 0, "with the real command processor");

        // 7a. Nothing here may end a command that is still working. This suite's
        // own driver once did, and a script ran only if it beat that: 30 checks
        // red on a CI runner, green here, with the product fine on both.
        const slowAbs = await go({ argv: [path.join(onPath, "fplslow.cmd"), "x"] });
        ok(batchWas(slowAbs, "GOOD-SLOW"), `a .cmd that takes a second still finishes (${slowAbs.batch[0] ?? slowAbs.errors.join("; ")})`);
        ok(slowAbs.code === 7, `and its exit code comes back (${slowAbs.code})`);
        const slowBare = await go({ argv: ["fplslow.cmd", "x"], helperPathVar: pathOf(onPath) });
        ok(batchWas(slowBare, "GOOD-SLOW") && slowBare.code === 7, `so does a bare one (${slowBare.batch[0] ?? slowBare.errors.join("; ")}, exit ${slowBare.code})`);

        const line = verbatim ? [`${q}a b${q}`, "c"] : ["a b", "c"];
        const spacedAbs = await go({ argv: [spacedBatch, ...line] });
        ok(batchWas(spacedAbs, "GOOD-SPACED"), `an absolute .cmd whose path has spaces and & (${spacedAbs.batch[0] ?? spacedAbs.errors.join("; ")})`);
        ok(/args=\["a b" c\]/.test(spacedAbs.batch[0] ?? ""), "and a quoted argument arrives whole");

        const bare = await go({ argv: ["fplbatch.cmd", ...line], helperPathVar: pathOf(onPath) });
        ok(batchWas(bare, "GOOD-PATH"), `a bare .cmd on PATH runs (${bare.batch[0] ?? bare.errors.join("; ")})`);
        ok(/args=\["a b" c\]/.test(bare.batch[0] ?? ""), "and a quoted argument arrives whole");
        ok(bare.code === 7, `and its exit code comes back (${bare.code})`);

        // Both PATHs carry it, because cmd.exe looks a bare name up again in the
        // child's: that is what the check below it is about.
        const bareSpaced = await go({
            argv: ["fplspaced.cmd", ...line],
            helperPathVar: pathOf(spacedPath),
            childPathVar: pathOf(spacedPath),
        });
        ok(batchWas(bareSpaced, "GOOD-SPACED"), `a bare .cmd on a PATH entry with spaces and & (${bareSpaced.batch[0] ?? bareSpaced.errors.join("; ")})`);
        ok(/args=\["a b" c\]/.test(bareSpaced.batch[0] ?? ""), "and a quoted argument arrives whole");

        for (const [where, opts] of [
            ["the host cwd", { hostCwd: hostPlants }],
            ["beside the helper", { helper: helperBeside }],
            ["the cwd option", { cwd: optionPlants }],
        ]) {
            const r = await go({ argv: ["fplbatch.cmd", "x"], helperPathVar: pathOf(onPath), ...opts });
            ok(batchWas(r, "GOOD-PATH"), `a bare .cmd with a same-named file in ${where}: the PATH one ran (${r.batch[0] ?? r.errors.join("; ")})`);
        }
        const shadowed = await go({
            argv: ["fplbatch.cmd", "x"],
            helperPathVar: pathOf(onPath),
            childPathVar: pathOf(optionPlants, onPath),
        });
        ok(batchWas(shadowed, "GOOD-PATH"), `a bare .cmd with a same-named file earlier on the env option's PATH: the resolved one ran (${shadowed.batch[0] ?? shadowed.errors.join("; ")})`);
        expectMissing(await go({ argv: ["fplbatch.cmd"], hostCwd: hostPlants, helperPathVar: pathOf() }), "a bare .cmd ONLY in the host cwd");

        const relBatch = await go({ argv: [".\\rel.cmd"], hostCwd: hostPlants, cwd: optionPlants });
        ok(batchWas(relBatch, "GOOD-HOST-REL"), `.\\rel.cmd is the host cwd's, not the cwd option's (${relBatch.batch[0] ?? relBatch.errors.join("; ")})`);

        // Which command processor Windows starts for a batch file, with one
        // planted everywhere a search could look.
        const procPlants = await go({ argv: [absBatch, "x"], hostCwd: hostPlants, helper: helperBeside, cwd: optionPlants });
        ok(
            batchWas(procPlants, "GOOD-PATH") && procPlants.records.length === 0,
            `cmd.exe planted in all three places: the real one ran the script (${procPlants.batch[0] ?? said(procPlants)})`,
        );

        // ------------------------------------------------------------ not found
        console.log("8. not found stays useful");
        const missing = await go({ argv: ["fpl-no-such-program.exe", "x"], hostCwd: hostPlants });
        expectMissing(missing, "a missing program with an extension");
        const text = missing.errors.join("; ");
        ok(text.includes("fpl-no-such-program.exe"), `it names the program (${text.slice(0, 80)})`);
        ok(text.includes("not found on PATH"), "and says where it looked");
        ok(/current directory/.test(text), "and that the current directory is not searched");
        ok(text.includes(".\\fpl-no-such-program.exe"), "and how to ask for a program there");
        const noExt = await go({ argv: ["fpl-no-such-program"] });
        ok(/appends \.exe and NOTHING else/.test(noExt.errors.join("; ")), "with no extension it also names that rule");
        const missingAbs = await go({ argv: [path.join(clean, "gone.exe")] });
        expectMissing(missingAbs, "a missing absolute path");
        ok(missingAbs.errors.join("; ").includes("gone.exe"), "and it names the program");
        expectMissing(await go({ argv: [""] }), "an empty program name");
    }

    // ------------------------------------------------------- an empty environment
    // A block with no variables must still end in two NULs. One was
    // CreateProcessW GetLastError=87 on every release before this check.
    console.log("\n--- an empty environment ---");
    const realCmdExit = ["cmd.exe", "/d", "/c", "exit 7"];
    const withOne = await run({ argv: realCmdExit, childEnvExact: { FPL_SENTINEL: "1" } });
    ok(withOne.code === 7 && withOne.errors.length === 0, `control: one variable, cmd.exe starts and exits 7 (${withOne.code}, ${withOne.errors.join("; ").slice(0, 70)})`);
    const noVars = await run({ argv: realCmdExit, childEnvExact: {} });
    ok(noVars.pid !== null && noVars.errors.length === 0, `env {}: the command starts (${noVars.errors.join("; ").slice(0, 70) || `pid ${noVars.pid}`})`);
    ok(noVars.code === 7, `env {}: and its exit code comes back (${noVars.code})`);
    // The helper's own variable is what a merge would leak, so this is the check
    // that "empty" still means the caller's empty rather than the helper's.
    process.env.FPL_HELPER_ONLY = "leaked";
    const shownOne = await run({ argv: ["cmd.exe", "/d", "/c", "set"], childEnvExact: { FPL_SENTINEL: "shown" } });
    const shownNone = await run({ argv: ["cmd.exe", "/d", "/c", "set"], childEnvExact: {} });
    delete process.env.FPL_HELPER_ONLY;
    ok(/FPL_SENTINEL=shown/.test(shownOne.text), "control: `set` shows what the child was given");
    ok(shownNone.code === 0 && !/FPL_/.test(shownNone.text), `env {}: the child sees none of the helper's variables (exit ${shownNone.code})`);
    const noVarsBatch = path.join(onPath, "fplnovars.cmd");
    writeFileSync(noVarsBatch, "@exit /b 5\r\n");
    const batchNoVars = await run({ argv: [noVarsBatch], childEnvExact: {} });
    ok(batchNoVars.code === 5 && batchNoVars.errors.length === 0, `env {}: a .cmd starts too (exit ${batchNoVars.code}, ${batchNoVars.errors.join("; ").slice(0, 70)})`);

    console.log(failures === 0 ? `\nALL GREEN (${total})\n` : `\n${failures} of ${total} CHECK(S) FAILED\n`);
} finally {
    // A just-exited process can hold a directory for a moment. A leftover is
    // reported, and is not a verdict about lookup.
    try {
        rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (e) {
        console.log(`note: could not remove ${root}: ${e.code}`);
    }
}
process.exit(failures === 0 ? 0 : 1);
