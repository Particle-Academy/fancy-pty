// LIVE suite: real pseudoconsoles, real shells, real process accounting.
//
// Separate from `vitest run` on purpose. The unit suite covers the pure
// protocol and must stay fast and hermetic; this one spawns dozens of shells,
// takes seconds, and is the only thing that can answer "does a terminal
// actually work and does it give everything back". Run it with
// `npm run verify:pty`, and with `--expose-gc` so the leak reading is of the
// pty rather than of Node's pending collection.
//
// It runs against `dist/`, not `src/`, because the thing a consumer receives is
// the build. A live suite that imports source cannot catch a packaging fault,
// and a packaging fault is precisely what shipped empty installers before.

import { setTimeout as sleep } from "node:timers/promises";
import { execFileSync } from "node:child_process";

import { processStats } from "./process-stats.mjs";

import { open, helperPath } from "../../dist/index.js";

const isWindows = process.platform === "win32";

let failures = 0;
const ok = (cond, what) => {
    console.log(`  ${cond ? "ok  " : "FAIL"} ${what}`);
    if (!cond) failures++;
};

/** The shell and the incantations differ per platform; the assertions do not. */
const shell = isWindows
    ? { argv: ["cmd.exe"], eol: "\r\n", quit: "exit", size: "mode con", arith: "set /a 1234*5678" }
    : {
          argv: ["/bin/sh"],
          eol: "\n",
          quit: "exit",
          size: "stty size",
          arith: "expr 1234 \\* 5678",
      };

function collect(pty) {
    let out = "";
    pty.onData((b) => {
        out += b.toString("utf8");
    });
    const errors = [];
    pty.onError((e) => errors.push(e));
    const exit = new Promise((res) => pty.onExit(res));
    return { text: () => out, errors, exit };
}

const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => "TIMEOUT")]);

console.log(`\nfancy-pty live suite — ${process.platform}-${process.arch}`);
console.log(`helper: ${helperPath()}\n`);

// ------------------------------------------------------- 1. a shell runs
console.log("1. a real shell executes a real command");
{
    const pty = open({ argv: shell.argv, cols: 120, rows: 30, env: process.env });
    const c = collect(pty);
    ok(typeof pty.pid === "number", `helper spawned (pid ${pty.pid})`);
    await sleep(400);
    pty.write(`${shell.arith}${shell.eol}${shell.quit}${shell.eol}`);
    const code = await withTimeout(c.exit, 15000);
    ok(code !== "TIMEOUT", "the pty reported EXIT rather than hanging");
    ok(code === 0, `exit code 0 (got ${code})`);
    // THE ORACLE, and it is chosen rather than convenient: the PRODUCT never
    // appears in the input, so finding it proves the SHELL EXECUTED the
    // command. A check looking for the command TEXT would pass on a pty that
    // echoed keystrokes and ran nothing — which is exactly the state the first
    // spike was in while looking like it worked.
    ok(c.text().includes("7006652"), "the shell EXECUTED it — 7006652 is not in the input");
    ok(!c.text().includes("9999999"), "control: a token we never sent stayed absent");
    ok(c.errors.length === 0, `no error frames (${c.errors.map((e) => e.message).join("; ")})`);
}

// ------------------------------------------- 2. it is a console, at our size
console.log("\n2. the child gets a real terminal, at the size we asked for");
{
    const pty = open({ argv: shell.argv, cols: 97, rows: 31, env: process.env });
    const c = collect(pty);
    await sleep(400);
    pty.write(`${shell.size}${shell.eol}${shell.quit}${shell.eol}`);
    await withTimeout(c.exit, 15000);
    const text = c.text();
    // The size is the one value an INHERITED handle cannot fake. If the child
    // had been given the helper's own stdio instead of the pseudoconsole's —
    // the failure that `STARTF_USESTDHANDLES` with NULL handles fixes — there
    // would be no terminal here to report dimensions at all.
    if (isWindows) {
        ok(/Lines:\s*31/.test(text), "the console reports 31 rows — the value we set");
        ok(/Columns:\s*97/.test(text), "the console reports 97 columns — the value we set");
    } else {
        ok(/\b31 97\b/.test(text), "stty reports '31 97' — the values we set");
    }
}

// ------------------------------------------------------------- 3. resize
console.log("\n3. resize reaches the LIVE terminal");
{
    const pty = open({ argv: shell.argv, cols: 80, rows: 24, env: process.env });
    const c = collect(pty);
    await sleep(400);
    pty.resize(110, 45);
    await sleep(300);
    pty.write(`${shell.size}${shell.eol}${shell.quit}${shell.eol}`);
    await withTimeout(c.exit, 15000);
    const text = c.text();
    if (isWindows) {
        ok(/Lines:\s*45/.test(text), "after resize it reports 45 rows");
        ok(/Columns:\s*110/.test(text), "after resize it reports 110 columns");
    } else {
        ok(/\b45 110\b/.test(text), "after resize stty reports '45 110'");
    }
}

// ------------------------------------------------------------- 4. kill
console.log("\n4. kill tears down a shell that would never exit on its own");
{
    const pty = open({ argv: shell.argv, cols: 80, rows: 24, env: process.env });
    const c = collect(pty);
    await sleep(400);
    // No quit sent: this shell would sit at its prompt forever.
    pty.kill();
    const code = await withTimeout(c.exit, 15000);
    ok(code !== "TIMEOUT", "a killed pty still reports EXIT");
}

// ---------------------------------------------- 5. argv quoting, end to end
console.log("\n5. an argument with spaces survives the platform's argv handling");
{
    const argv = isWindows
        ? ["cmd.exe", "/c", "echo", "hello   spaced   world"]
        : ["/bin/sh", "-c", "echo 'hello   spaced   world'"];
    const pty = open({ argv, env: process.env });
    const c = collect(pty);
    await withTimeout(c.exit, 15000);
    ok(c.text().includes("hello   spaced   world"), "the argument arrived intact, spacing and all");
}

// ----------------------------------------------------- 6. a failed spawn
console.log("\n6. a failed spawn is an ERROR, never a silent empty terminal");
{
    const pty = open({ argv: ["this-program-does-not-exist-xyz"], env: process.env });
    const c = collect(pty);
    const code = await withTimeout(c.exit, 15000);
    ok(code !== "TIMEOUT", "a failed spawn still reports EXIT rather than hanging");
    ok(c.errors.length > 0, "and it reported an error");
}

// ----------------------------------- 6c. the shell inherits 0-2 and NOTHING else
if (!isWindows) {
    console.log("\n6c. an fd the CONSUMER inherited does not reach the pty's shell (genie#1452)");
    // genie#1452: the helper's forked child closed only the fds it knew about,
    // so every non-CLOEXEC fd its parent passed down rode through execvp into
    // the shell -- on Genie's VM, a DevTools listening socket on :9222 that
    // kept accepting connections for as long as the terminal lived.
    //
    // WHY THIS DRIVES THE HELPER DIRECTLY instead of going through `open()`:
    // Node cannot produce the condition. Measured on Node 22 (Linux):
    // started with fd 9 open and NOT close-on-exec, Node marks it O_CLOEXEC
    // at startup (/proc/self/fdinfo/9 flags 02100000), and libuv opens all of
    // its own fds CLOEXEC, so a helper spawned by a plain Node process never
    // receives one. The first draft of this check went through `open()` and
    // its positive control caught exactly that. A real consumer gets there
    // through native code opening an fd after that startup sweep (Genie's
    // was Chromium's), which a test cannot reproduce portably. So the helper
    // is started by a SHELL holding fd 9 (`9</dev/null` is not CLOEXEC),
    // speaking the frame protocol over a pipe -- exactly what Node does,
    // minus the sweep.
    const { spawnSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const pathMod = await import("node:path");
    const { encodeSpawn, frame, FrameDecoder } = await import("../../dist/index.js");

    const LEAKED = 9;
    // `exec 8<` opens fd 8 INSIDE the shell: a positive control proving the
    // probe reports a non-std fd the shell really has.
    const PROBE =
        `exec 8</dev/null; printf 'FDS:'; ` +
        `for n in 0 1 2 8 ${LEAKED}; do [ -e /dev/fd/$n ] && printf '%s,' $n; done; echo ':END'`;
    const parse = (text) => {
        const m = text.match(/FDS:([0-9,]*):END/);
        return m ? m[1].split(",").filter(Boolean).map(Number) : null;
    };

    const dir = mkdtempSync(pathMod.join(tmpdir(), "fancy-pty-fd-"));
    /**
     * Run the helper with fd 9 held, feeding it one SPAWN frame. The `sleep`
     * keeps its stdin open: EOF there means "the controller died", and the
     * helper would kill the shell before it printed (F1).
     */
    const runHelper = (argv) => {
        const file = pathMod.join(dir, `spawn-${Math.random().toString(36).slice(2)}.bin`);
        writeFileSync(file, frame(0x00, encodeSpawn({ argv, env: process.env, cols: 80, rows: 24 })));
        const r = spawnSync(
            "/bin/sh",
            ["-c", `{ cat "$1"; sleep 2; } | "$0" ${LEAKED}</dev/null`, helperPath(), file],
            { timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
        );
        const dec = new FrameDecoder();
        let data = "";
        let exit;
        const errors = [];
        for (const f of r.stdout ? dec.push(r.stdout) : []) {
            if (f.kind === 0x81) data += f.payload.toString("utf8");
            else if (f.kind === 0x82) exit = f.payload.readUInt32LE(0);
            else if (f.kind === 0x83) errors.push(f.payload.toString("utf8"));
        }
        return { data, exit, errors, status: r.status };
    };

    // Positive control: the SAME redirection on a plain exec. If fd 9 did not
    // reach this shell, "absent under the pty" would prove nothing.
    const plain = spawnSync("/bin/sh", ["-c", `"$0" -c "$1" ${LEAKED}</dev/null`, "/bin/sh", PROBE], {
        encoding: "utf8",
    });
    const control = parse(plain.stdout ?? "");
    ok(
        Array.isArray(control) && control.includes(LEAKED) && control.includes(8),
        `control: a plain exec under the same redirection DOES carry fd ${LEAKED}, and the probe sees it (${JSON.stringify(control)})`,
    );

    const sub = runHelper(["/bin/sh", "-c", PROBE]);
    const fds = parse(sub.data);
    ok(Array.isArray(fds), `the pty's shell ran the probe (${JSON.stringify(sub.data.slice(0, 200))})`);
    ok([0, 1, 2].every((n) => fds?.includes(n)), `the pty's shell has 0, 1 and 2 (${JSON.stringify(fds)})`);
    ok(fds?.includes(8) === true, "control: the probe sees an fd the shell opened itself (8)");
    ok(fds !== null && !fds.includes(LEAKED), `the pty's shell does NOT have the helper's inherited fd ${LEAKED} (${JSON.stringify(fds)})`);
    ok(sub.exit === 0 && sub.errors.length === 0, `and exited 0 with no error frames (exit ${sub.exit}; ${sub.errors.join("; ")})`);

    // The fix closes every fd >= 3 EXCEPT the exec-failure pipe. Close that one
    // too and a failed exec reads as EOF, i.e. "exec succeeded", so the
    // consumer gets a silent empty terminal instead of this error. Run under
    // the same fd layout so it exercises the rewritten child path.
    const bad = runHelper(["this-program-does-not-exist-xyz"]);
    ok(bad.exit !== undefined, `a failed exec still reports EXIT (${bad.exit})`);
    ok(
        bad.errors.some((m) => /failed to start/.test(m)),
        `and still reports WHY it failed (${JSON.stringify(bad.errors).slice(0, 160)})`,
    );
}

// ------------------------------------------ 6b. Windows command resolution
if (isWindows) {
    console.log("\n6b. how a bare command name resolves on Windows");

    // MEASURED, and pinned here so it cannot change silently. `claude · tynn`
    // found that node-pty's conpty path throws `File not found: ` with nothing
    // after the colon for a bare `cmd` -- a user typing `cmd` into a command
    // box hits it. fancy-pty does NOT, because the helper appends `.exe` when it
    // resolves a name. But it appends ONLY `.exe`, so the rest of PATHEXT does
    // not resolve, and that boundary is exactly what these three assertions fix
    // in place. Which file a name means is lookup.live.mjs.
    const bare = open({ argv: ["cmd", "/c", "echo", "NOEXT-OK"], env: process.env });
    const b = collect(bare);
    await withTimeout(b.exit, 15000);
    ok(b.text().includes("NOEXT-OK"), "a bare `cmd` resolves — .exe is appended");

    // A .cmd file cannot be exec'd directly at all: it is not an executable
    // image. Written to a temp file rather than relying on npm's layout, so the
    // assertion does not depend on what the runner happens to have installed.
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const pathMod = await import("node:path");
    const dir = mkdtempSync(pathMod.join(tmpdir(), "fancy-pty-res-"));
    const script = pathMod.join(dir, "hello.cmd");
    writeFileSync(script, "@echo BATCH-RAN\r\n");

    // A .cmd WITH its extension runs — Windows invokes it through the command
    // processor itself. This assertion exists because I assumed the opposite
    // and wrote an error message saying so; the measurement said `hello.cmd`
    // exits 0 and prints. Pinned so the claim in the error text stays true.
    const batch = open({ argv: [script], env: process.env });
    const bt = collect(batch);
    await withTimeout(bt.exit, 15000);
    ok(bt.text().includes("BATCH-RAN"), "a .cmd WITH its extension runs directly");
    ok(bt.errors.length === 0, "and reports no error");

    // Drop the extension and it does not resolve: `.exe` is the only one
    // CreateProcessW appends. This is the real boundary, and the error has to
    // say which side of it you are on.
    const bare2 = open({ argv: [script.replace(/\.cmd$/, "")], env: process.env });
    const b2 = collect(bare2);
    await withTimeout(b2.exit, 15000);
    ok(b2.errors.length > 0, "the SAME script without its extension fails");
    ok(
        b2.errors.some((e) => /appends \.exe and NOTHING else/.test(e.message)),
        `and the error names the rule rather than just an errno (${b2.errors
            .map((e) => e.message)
            .join("; ")
            .slice(0, 120)})`,
    );

    // The documented way to run one. This is what a consumer should do, so it
    // is asserted rather than merely described.
    const viaShell = open({ argv: ["cmd.exe", "/c", script], env: process.env });
    const vs = collect(viaShell);
    await withTimeout(vs.exit, 15000);
    ok(vs.text().includes("BATCH-RAN"), "and running it through cmd.exe /c works");
}

// ------------------------------- 6d. windowsVerbatimArguments, Windows half
if (isWindows) {
    console.log("\n6d. windowsVerbatimArguments: the line reaches the child as written (genie#1428, #1431)");

    // Every assertion reads what the child REPORTED (fixtures/cmdline-echo.rs:
    // GetCommandLineW and its parsed argv, as numbers, to a file), never pty
    // text. Pty text is used only for cmd.exe's own error messages.
    const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } =
        await import("node:fs");
    const { tmpdir } = await import("node:os");
    const pathMod = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { spawnSync } = await import("node:child_process");

    const root = realpathSync.native(mkdtempSync(pathMod.join(tmpdir(), "fancy-pty-verbatim-")));
    try {
        const source = fileURLToPath(new URL("./fixtures/cmdline-echo.rs", import.meta.url));
        const noSpaces = pathMod.join(root, "bare");
        const spaced = pathMod.join(root, "dir with space");
        mkdirSync(noSpaces);
        mkdirSync(spaced);
        const echo = pathMod.join(noSpaces, "echo.exe");
        execFileSync(
            "rustc",
            ["-C", "target-feature=+crt-static", "-C", "debuginfo=0", source, "-o", echo],
            { stdio: "pipe", windowsHide: true },
        );
        const spacedEcho = pathMod.join(spaced, "echo.exe");
        copyFileSync(echo, spacedEcho);
        // THE PLANT. CreateProcessW given no application name and an unquoted
        // `...\dir with space\echo.exe` tries `...\dir.exe` FIRST.
        const plant = pathMod.join(root, "dir.exe");
        copyFileSync(echo, plant);

        ok(!/\s/.test(echo), `precondition: the no-spaces path really has none (${echo})`);

        const units = (a) => String.fromCharCode(...a);
        const decode = (r) => ({ exe: units(r.exe), raw: units(r.raw), argv: r.argv.map(units) });
        let runs = 0;
        const report = (out) =>
            existsSync(out)
                ? readFileSync(out, "utf8")
                      .split("\n")
                      .filter(Boolean)
                      .map((l) => decode(JSON.parse(l)))
                : [];
        const run = async (options) => {
            const out = pathMod.join(root, `out-${runs++}.jsonl`);
            const pty = open({
                cols: 400,
                rows: 30,
                env: { ...process.env, FANCY_PTY_ECHO_OUT: out },
                ...options,
            });
            const c = collect(pty);
            const code = await withTimeout(c.exit, 15000);
            if (code === "TIMEOUT") pty.kill();
            return {
                code,
                records: report(out),
                text: c.text().replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, ""),
                errors: c.errors.map((e) => e.message),
            };
        };
        const viaCmd = (line, verbatim = true) =>
            run({
                argv: ["cmd.exe", "/d", "/s", "/c", line],
                ...(verbatim ? { windowsVerbatimArguments: true } : {}),
            });
        const argvOf = (r) => JSON.stringify(r.records[0]?.argv.slice(1));
        const q = '"';
        const codepoints = (s, n = 24) =>
            [...s.slice(0, n)].map((ch) => ch.codePointAt(0).toString(16)).join(" ");

        // What cmd.exe would be handed. The fixture stands in for cmd.exe with
        // the same arguments, so the difference is read off the command line
        // itself, as code points, rather than inferred from cmd's complaint.
        console.log("     -- the bytes, with the fixture standing in for cmd.exe");
        const lineGenie = `${q}${echo}${q} --version`;
        const quotedDefault = await run({ argv: [echo, "/d", "/s", "/c", lineGenie] });
        const quotedVerbatim = await run({
            argv: [echo, "/d", "/s", "/c", lineGenie],
            windowsVerbatimArguments: true,
        });
        const prefix = `${echo} /d /s /c `.length;
        const tailDefault = (quotedDefault.records[0]?.raw ?? "").slice(prefix);
        const tailVerbatim = (quotedVerbatim.records[0]?.raw ?? "").slice(prefix);
        console.log(`     default : ${quotedDefault.records[0]?.raw}`);
        console.log(`               starts ${codepoints(tailDefault, 4)}`);
        console.log(`     verbatim: ${quotedVerbatim.records[0]?.raw}`);
        console.log(`               starts ${codepoints(tailVerbatim, 4)}`);
        ok(tailDefault.startsWith(`${q}\\${q}`), "control: by default the line's quote is sent as a backslash-quote");
        ok(
            quotedVerbatim.records[0]?.raw === `${echo} /d /s /c ${lineGenie}`,
            "verbatim: the command line is the elements joined with single spaces, unaltered",
        );

        console.log("     -- through a real cmd.exe /d /s /c");
        // The positive control, and Genie's measured failure. Without this the
        // checks below could pass on a cmd.exe that was never going to object.
        const noOption = await viaCmd(lineGenie, false);
        ok(noOption.records.length === 0, "control: WITHOUT the option the program does not run");
        ok(
            noOption.text.includes(`\\${q}`) && /not recognized/.test(noOption.text),
            `control: and cmd.exe reports the backslash-quote (${noOption.text.trim().slice(0, 100)})`,
        );

        // Genie's failing case: a quoted path with no spaces, the line as written.
        const genie = await viaCmd(lineGenie);
        ok(genie.records.length === 1, `a quoted path with no spaces runs (${genie.text.trim().slice(0, 100)})`);
        ok(argvOf(genie) === JSON.stringify(["--version"]), `and its argument arrived (${argvOf(genie)})`);
        ok(genie.code === 0 && genie.errors.length === 0, `and it exited 0 with no error (${genie.code})`);

        // Outer quotes: cmd's /s removes the first and the last quote on the
        // line. That is why Node wraps the line, and consumers must too.
        const wrap = (line) => `${q}${line}${q}`;
        const pathWithSpaces = await viaCmd(wrap(`${q}${spacedEcho}${q} --flag`));
        ok(pathWithSpaces.records.length === 1, `a quoted program path with spaces runs (${pathWithSpaces.text.trim().slice(0, 100)})`);
        ok(
            pathWithSpaces.records[0]?.exe.toLowerCase() === spacedEcho.toLowerCase(),
            `and it is the right image (${pathWithSpaces.records[0]?.exe})`,
        );
        ok(argvOf(pathWithSpaces) === JSON.stringify(["--flag"]), `with its argument (${argvOf(pathWithSpaces)})`);

        // Why the README insists on the outer pair. /s strips the only quotes
        // the line has, and cmd.exe then reads `...\dir` as the program, which
        // PATHEXT resolves to the plant. Not a failure: the WRONG PROGRAM runs.
        const unwrapped = await viaCmd(`${q}${spacedEcho}${q} --flag`);
        ok(
            unwrapped.records.length === 1 && unwrapped.records[0].exe.toLowerCase() === plant.toLowerCase(),
            `control: the same line WITHOUT the outer quotes runs the plant (${unwrapped.records[0]?.exe})`,
        );

        const quotedArg = await viaCmd(wrap(`${q}${echo}${q} ${q}two words${q} tail`));
        ok(argvOf(quotedArg) === JSON.stringify(["two words", "tail"]), `a quoted argument arrives whole (${argvOf(quotedArg)})`);

        const metachars = await viaCmd(wrap(`${q}${echo}${q} ${q}a&b|c${q}`));
        ok(metachars.records.length === 1, "& and | inside quotes start no second command");
        ok(argvOf(metachars) === JSON.stringify(["a&b|c"]), `and reach the child literally (${argvOf(metachars)})`);

        const operator = await viaCmd(wrap(`${q}${echo}${q} one & ${q}${echo}${q} two`));
        ok(
            operator.records.length === 2,
            `control: & OUTSIDE quotes IS an operator, so the option hands the line to cmd unprotected (${operator.records.length} ran)`,
        );

        console.log("     -- the same contract as child_process");
        const parityArgs = ["a", `${q}b c${q}`, "d\\", `e\\${q}f`];
        const pty = await run({ argv: [echo, ...parityArgs], windowsVerbatimArguments: true });
        const nodeOut = pathMod.join(root, "node.jsonl");
        const nodeRun = (file, args) =>
            spawnSync(file, args, {
                windowsVerbatimArguments: true,
                windowsHide: true,
                env: { ...process.env, FANCY_PTY_ECHO_OUT: nodeOut },
            });
        nodeRun(echo, parityArgs);
        const nodeRecord = report(nodeOut)[0];
        console.log(`     node: ${nodeRecord?.raw}`);
        console.log(`     pty : ${pty.records[0]?.raw}`);
        ok(
            pty.records[0]?.raw !== undefined && pty.records[0]?.raw === nodeRecord?.raw,
            "the command line is byte-identical to Node's windowsVerbatimArguments",
        );

        console.log("     -- what runs, and what fails");
        const plantSelf = await run({ argv: [plant] });
        ok(
            plantSelf.records[0]?.exe.toLowerCase() === plant.toLowerCase(),
            "control: the plant is a working program that identifies itself",
        );

        // The program is the program, whatever else is on disk. Element 0 alone
        // keeps its quoting.
        const trap = await run({ argv: [spacedEcho, "--flag"], windowsVerbatimArguments: true });
        ok(
            trap.records.length === 1 && trap.records[0].exe.toLowerCase() === spacedEcho.toLowerCase(),
            `an unquoted-by-the-caller program with spaces runs ITSELF, not the plant (${trap.records[0]?.exe})`,
        );
        ok(
            trap.records[0]?.raw === `${q}${spacedEcho}${q} --flag`,
            `element 0 alone was quoted (${trap.records[0]?.raw})`,
        );
        ok(argvOf(trap) === JSON.stringify(["--flag"]), `so the child's own argv lines up (${argvOf(trap)})`);

        // Not asserted, because it is Node's behaviour rather than ours; printed
        // so the one place this deliberately differs stays visible.
        rmSync(nodeOut, { force: true });
        nodeRun(spacedEcho, ["--flag"]);
        const nodeSpaced = report(nodeOut)[0];
        console.log(`     note: Node here sends ${nodeSpaced?.raw}`);
        console.log(`           and its child parses argv ${JSON.stringify(nodeSpaced?.argv)}`);

        const line = `${q}${echo}${q} --version`;
        const whole = await run({ argv: [line], windowsVerbatimArguments: true });
        ok(whole.records.length === 0, "a whole line in element 0 is not parsed for a program");
        ok(
            whole.errors.some((m) => /element 0 is the program/.test(m)),
            `and the refusal says why (${whole.errors.join("; ").slice(0, 140)})`,
        );
        ok(whole.code === 1, `and the pty still reports EXIT 1 (${whole.code})`);

        const missing = await run({
            argv: ["this-program-does-not-exist-xyz", "/c", `${q}x${q}`],
            windowsVerbatimArguments: true,
        });
        ok(missing.code === 1, `a failed verbatim start reports EXIT 1 (${missing.code})`);
        ok(
            missing.errors.some(
                (m) => m.includes("this-program-does-not-exist-xyz") && /appends \.exe and NOTHING else/.test(m),
            ),
            `and the usual error, naming the program and the rule (${missing.errors.join("; ").slice(0, 110)})`,
        );

        const missingExt = await run({
            argv: ["this-program-does-not-exist-xyz.exe", `${q}x${q}`],
            windowsVerbatimArguments: true,
        });
        ok(
            missingExt.errors.some((m) => /not found on PATH/.test(m)),
            `and with an extension, the plain not-found hint (${missingExt.errors.join("; ").slice(0, 110)})`,
        );

        const bareCmd = await run({
            argv: ["cmd", "/d", "/s", "/c", lineGenie],
            windowsVerbatimArguments: true,
        });
        ok(bareCmd.records.length === 1, "a bare `cmd` still resolves in verbatim mode");

        console.log("     -- default off: nothing else moved");
        const hand = `${echo} ${q}a b${q} ${q}q\\${q}r${q} C:\\d\\ ${q}${q}`;
        const argsForDefault = ["a b", `q${q}r`, "C:\\d\\", ""];
        const unset = await run({ argv: [echo, ...argsForDefault] });
        const off = await run({ argv: [echo, ...argsForDefault], windowsVerbatimArguments: false });
        ok(unset.records[0]?.raw === hand, `an ordinary spawn's command line is unchanged (${unset.records[0]?.raw})`);
        ok(off.records[0]?.raw === hand, "and `false` is the same line");
        ok(
            JSON.stringify(unset.records[0]?.argv.slice(1)) === JSON.stringify(argsForDefault),
            "and the child parses back exactly the list it was given",
        );
        const spacedDefault = await run({ argv: [spacedEcho, "x"] });
        ok(
            spacedDefault.records[0]?.raw === `${q}${spacedEcho}${q} x` &&
                spacedDefault.records[0]?.exe.toLowerCase() === spacedEcho.toLowerCase(),
            "and a default spawn of a spaced program still runs that program",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

// ------------------------------- 6e. windowsVerbatimArguments, POSIX half
if (!isWindows) {
    console.log("\n6e. windowsVerbatimArguments is IGNORED on POSIX, as in Node");
    // argv goes straight to execvp, so there is no command line for the option
    // to affect. The same request with and without it must behave identically.
    const argv = ["/bin/sh", "-c", 'printf "[%s]" "$1"; echo', "sh", 'a "b" c'];
    const go = async (options) => {
        const pty = open({ argv, env: process.env, ...options });
        const c = collect(pty);
        const code = await withTimeout(c.exit, 15000);
        return { code, text: c.text(), errors: c.errors };
    };
    const plain = await go({});
    const flagged = await go({ windowsVerbatimArguments: true });
    ok(plain.text.includes('[a "b" c]'), `control: the argument arrives whole without it (${JSON.stringify(plain.text)})`);
    ok(flagged.text === plain.text, `and identically with it (${JSON.stringify(flagged.text)})`);
    ok(flagged.code === 0 && flagged.errors.length === 0, `with exit 0 and no error (${flagged.code})`);
}

// ------------------------------------------------------- 6f. no environment
console.log("\n6f. a pty with no environment variables at all still starts");
{
    const exitSeven = isWindows ? ["cmd.exe", "/d", "/c", "exit 7"] : ["/bin/sh", "-c", "exit 7"];
    for (const [label, options] of [
        ["env: {}", { env: {} }],
        ["no env option", {}],
    ]) {
        const c = collect(open({ argv: exitSeven, ...options }));
        const code = await withTimeout(c.exit, 15000);
        ok(code === 7 && c.errors.length === 0, `${label}: exit 7, no error (${code}${c.errors.length ? `, ${c.errors[0].message}` : ""})`);
    }
}

// ------------------------------------ 6g. a .cmd's arguments, on every platform
console.log("\n6g. a batch file with an argument cmd.exe acts on is refused, on every OS");
{
    const hostile = "a&b";
    // No file by any of these names exists. Lookalike spellings (trailing dots and
    // spaces) stay in batch-arguments.test.ts, which launches nothing.
    for (const program of ["x.cmd", "x.bat", "X.CMD", "x.Bat", "./x.cmd", "/no/such/x.cmd"]) {
        let thrown;
        try {
            collect(open({ argv: [program, hostile], env: process.env }));
        } catch (e) {
            thrown = e;
        }
        ok(
            /refusing to start the batch file/.test(thrown?.message ?? "") && thrown.message.includes("argv[1]"),
            `${JSON.stringify(program)}: open() throws (${thrown?.message.slice(0, 45) ?? "it did not throw"})`,
        );
    }
    // Reaches the helper, which reports a missing program: the point is only that
    // the rule let it through.
    for (const [what, argv, options] of [
        ["a plain argument", ["/no/such/x.cmd", "a b"], {}],
        ["verbatim mode", ["/no/such/x.cmd", hostile], { windowsVerbatimArguments: true }],
    ]) {
        const c = collect(open({ argv, env: process.env, ...options }));
        await withTimeout(c.exit, 15000);
        const text = c.errors.map((e) => e.message).join("; ");
        ok(!/refusing/.test(text), `${what} is not refused (${text.slice(0, 60)})`);
    }
}

// ----------------------------------- 6h. does POSIX have its own version of this?
if (!isWindows) {
    console.log("\n6h. POSIX: execvp starts no shell, so a hostile argument arrives literally");
    const { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = mkdtempSync(path.join(tmpdir(), "fancy-pty-posix-args-"));
    try {
        const marker = path.join(root, "marker");
        const out = path.join(root, "out");
        const go = async (argv, options = {}) => {
            rmSync(out, { force: true });
            const c = collect(open({ argv, env: { ...process.env, FPL_OUT: out }, ...options }));
            const code = await withTimeout(c.exit, 15000);
            return { code, errors: c.errors };
        };
        const received = () => (existsSync(out) ? readFileSync(out, "utf8").split("\0").slice(0, -1) : null);

        // The positive control: the same text, given to a shell, does run the marker.
        await go(["/bin/sh", "-c", `a;touch ${marker}`]);
        ok(existsSync(marker), "control: this text run by a shell does create the marker");
        rmSync(marker, { force: true });

        const recorder = "printf '%s\\0' \"$@\" > \"$FPL_OUT\"\n";
        const scripts = [
            ["a script with a shebang", "with-shebang.sh", `#!/bin/sh\n${recorder}`],
            ["a script with no shebang (execvp falls back to sh)", "no-shebang.sh", recorder],
        ];
        const hostileArgs = [
            `a&touch ${marker}`,
            `a;touch ${marker}`,
            `a|touch ${marker}`,
            `$(touch ${marker})`,
            `\`touch ${marker}\``,
            `a\ntouch ${marker}`,
            `a>${marker}`,
            `a"b'c`,
            "%PATH%",
            "$PATH",
            "!x!",
            "*",
            "~",
        ];
        for (const [what, name, body] of scripts) {
            const file = path.join(root, name);
            writeFileSync(file, body);
            chmodSync(file, 0o755);
            const r = await go([file, ...hostileArgs]);
            ok(r.code === 0 && r.errors.length === 0, `${what} runs (exit ${r.code})`);
            ok(JSON.stringify(received()) === JSON.stringify(hostileArgs), `${what}: every argument arrives byte for byte`);
            ok(!existsSync(marker), `${what}: nothing else ran`);
        }

        // A .cmd here is not a batch file at all. It is refused for consistency, so
        // the same code behaves the same on every OS, and not because of a risk:
        // verbatim mode shows the same request is harmless here.
        const named = path.join(root, "really-a-shell-script.cmd");
        writeFileSync(named, `#!/bin/sh\n${recorder}`);
        chmodSync(named, 0o755);
        const plain = await go([named, "a b"]);
        ok(plain.code === 0 && JSON.stringify(received()) === '["a b"]', "a .cmd with a plain argument runs, as the script it is");
        let refused;
        try {
            await go([named, `a&touch ${marker}`]);
        } catch (e) {
            refused = e;
        }
        ok(/refusing/.test(refused?.message ?? ""), "the same .cmd with & is refused, for consistency");
        const flagged = await go([named, `a&touch ${marker}`], { windowsVerbatimArguments: true });
        ok(flagged.code === 0 && JSON.stringify(received()) === JSON.stringify([`a&touch ${marker}`]), "with the option it runs, and the argument is literal");
        ok(!existsSync(marker), "and nothing else ran");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

// --------------------------------------------------------- 7. THE BAR
console.log("\n7. THE BAR: spawn/exit cycles must retain nothing");
{
    const CYCLES = Number(process.env.FANCY_PTY_CYCLES ?? 60);
    const quick = isWindows ? ["cmd.exe", "/c", "exit"] : ["/bin/sh", "-c", "exit"];

    // Warm-up, excluded from the measurement. The first spawn pays for module
    // loading, the OS's own caches and Node's stream machinery; counting it
    // would attribute one-time costs to every pty.
    await new Promise((r) => open({ argv: quick, env: process.env }).onExit(r));
    await sleep(400);

    // THE THREE QUANTITIES THE INCIDENT WAS MEASURED IN -- threads, OS
    // handles, and resident memory. Not libuv handles, which an earlier version
    // of this file used and which are a different thing in different units; see
    // process-stats.mjs for what that cost.
    const gauge = () => processStats();

    const fmt = (s) =>
        `threads ${s.threads ?? "n/a"}, ${s.handlesLabel} ${s.handles ?? "n/a"}, ` +
        `rss ${(s.rss / 1e6).toFixed(1)} MB`;

    // A POSITIVE CONTROL first, because a leak check that has never seen the
    // gauges move is a check that cannot go red. Hold 20 ptys open and confirm
    // the numbers RISE; without this, "nothing retained" is indistinguishable
    // from "nothing measured".
    const base = gauge();
    const live = [];
    for (let i = 0; i < 20; i++) {
        const p = open({ argv: shell.argv, cols: 80, rows: 24, env: process.env });
        p.onData(() => {});
        live.push(p);
    }
    await sleep(1200);
    const withLive = gauge();
    console.log(`     idle:    ${fmt(base)}`);
    console.log(`     20 live: ${fmt(withLive)}`);

    // At least one gauge must move, and it is named -- "something went up" is
    // not a control if you cannot say which instrument saw it.
    const moved = [];
    if (base.threads !== null && withLive.threads > base.threads) moved.push("threads");
    if (base.handles !== null && withLive.handles > base.handles) moved.push("handles");
    ok(moved.length > 0, `positive control: 20 live ptys moved ${moved.join(" + ") || "NOTHING"}`);

    for (const p of live) p.kill();
    await Promise.all(live.map((p) => new Promise((r) => p.onExit(r))));
    await sleep(1500);

    const before = gauge();
    const t0 = Date.now();
    let exits = 0;
    for (let i = 0; i < CYCLES; i++) {
        const pty = open({ argv: quick, env: process.env });
        pty.onData(() => {});
        await new Promise((r) => pty.onExit(r));
        exits++;
    }
    const ms = Date.now() - t0;

    // Settle before measuring, or the reading is of Node's pending pipe
    // teardown rather than of anything the pty retained.
    await sleep(2000);
    if (global.gc) global.gc();
    await sleep(300);
    const after = gauge();

    const per = (a, b) => (a === null || b === null ? null : (b - a) / CYCLES);
    const perThreads = per(before.threads, after.threads);
    const perHandles = per(before.handles, after.handles);
    const perMb = (after.rss - before.rss) / 1024 / 1024 / CYCLES;

    console.log(`     ${exits}/${CYCLES} exited in ${ms} ms (${Math.round(ms / CYCLES)} ms each)`);
    console.log(`     before:  ${fmt(before)}`);
    console.log(`     after:   ${fmt(after)}`);
    console.log(
        `     per exited pty: ${perThreads === null ? "n/a" : perThreads.toFixed(3)} threads, ` +
            `${perHandles === null ? "n/a" : perHandles.toFixed(3)} ${before.handlesLabel}, ` +
            `${perMb.toFixed(3)} MB`,
    );

    ok(exits === CYCLES, `every pty exited (${exits}/${CYCLES})`);

    // `claude · tynn`'s thresholds, per exited pty, set so the incident's own
    // numbers fail by 10x. Their Windows node-pty baseline, measured
    // 2026-10-10 on a clean VM: 1.067 threads, 18.27 handles, 13.303 MB per
    // EXITED pty -- so all three of these go red against the engine this
    // replaces, which is what makes them worth asserting.
    if (perThreads === null) {
        // SKIPPED OUT LOUD. An unavailable metric is never scored as zero:
        // that hands out a pass for a measurement that did not happen.
        console.log("  SKIP threads <= 0.1 — this platform did not report a thread count");
    } else {
        ok(perThreads <= 0.1, `retained <= 0.1 threads per exited pty (${perThreads.toFixed(3)})`);
    }
    if (perHandles === null) {
        console.log(`  SKIP handles <= 1.0 — this platform did not report ${before.handlesLabel}`);
    } else {
        ok(
            perHandles <= 1.0,
            `retained <= 1.0 ${before.handlesLabel} per exited pty (${perHandles.toFixed(3)})`,
        );
    }
    ok(perMb <= 0.5, `retained <= 0.5 MB per exited pty (${perMb.toFixed(3)})`);
}

// ------------------------------------ 7b. issue #4: no VISIBLE console window
if (isWindows) {
    console.log("\n7b. the pty's console exists but is NOT VISIBLE (issue #4)");

    // WHY THIS IS HERE AND NOT IN A VM SMOKE TEST. `claude · tynn`'s Windows
    // acceptance runs headless over CDP in session 0, so "no window appeared"
    // is not something that VM can observe, and they said so rather than
    // claiming it. This closes the gap from the other direction: the CHILD
    // reports its own console's visibility from inside the pty, which needs no
    // desktop, no session and nobody looking at a screen — and it is checked on
    // every run rather than once by eye.
    //
    // Issue #4 was a stray visible console per shell under a windowless
    // detached host, plus a kill path that forked an un-hidden agent. fancy-pty
    // ships no agent, so only the first half is even expressible, and this is
    // the assertion for it.
    //
    // NOTE THE SHAPE OF THE ASSERTION, because the obvious version is wrong: a
    // ConPTY child ALWAYS has a non-null console HWND — conhost creates a window
    // and never shows it. So non-null is correct and expected; VISIBLE is the
    // failure. An earlier probe of mine asserted non-null was the bug and
    // invented one for a minute.
    const ps = [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -Namespace W -Name N -MemberDefinition '" +
            '[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();' +
            '[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);' +
            "'; $h = [W.N]::GetConsoleWindow(); " +
            '"HWND=$h VISIBLE=$([W.N]::IsWindowVisible($h))"; exit',
    ];

    const probe = open({ argv: ps, cols: 90, rows: 30, env: process.env });
    const pc = collect(probe);
    await withTimeout(pc.exit, 30000);
    const report = pc
        .text()
        // Strip CSI sequences and OSC strings so the match sees the text
        // the shell printed rather than the terminal control around it.
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "")
        .match(/HWND=(\S+)\s+VISIBLE=(\w+)/);

    ok(report !== null, `the child reported its console state (${pc.text().slice(-60).trim()})`);
    if (report) {
        const [, hwnd, visible] = report;
        ok(hwnd !== "0", `the child HAS a console (HWND ${hwnd}) — expected, conhost always makes one`);
        ok(
            visible.toLowerCase() === "false",
            `and that console is NOT VISIBLE (IsWindowVisible=${visible}) — issue #4 absent`,
        );
    }
}

// ------------------------------------------------------- 8. no orphans
console.log("\n8. nothing survives the run");
{
    let alive = 0;
    try {
        if (isWindows) {
            const out = execFileSync(
                "tasklist",
                ["/FI", "IMAGENAME eq fancy-pty-helper.exe", "/NH"],
                { encoding: "utf8", windowsHide: true },
            );
            alive = out.split("\n").filter((l) => /fancy-pty-helper\.exe/i.test(l)).length;
        } else {
            const out = execFileSync("ps", ["-eo", "comm"], { encoding: "utf8" });
            alive = out.split("\n").filter((l) => /fancy-pty-helper/.test(l)).length;
        }
    } catch {
        alive = -1;
    }
    // This is the check whose absence let 31 orphaned OpenConsole.exe processes
    // jam an upgrade. A per-pty process that does not exit is the leak with
    // extra steps.
    ok(alive === 0, `no helper processes left running (${alive})`);
}

console.log(failures === 0 ? "\nALL GREEN\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
