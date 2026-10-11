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

// ------------------------------------------ 6b. Windows command resolution
if (isWindows) {
    console.log("\n6b. how a bare command name resolves on Windows");

    // MEASURED, and pinned here so it cannot change silently. `claude · tynn`
    // found that node-pty's conpty path throws `File not found: ` with nothing
    // after the colon for a bare `cmd` -- a user typing `cmd` into a command
    // box hits it. fancy-pty does NOT, because `CreateProcessW` appends `.exe`
    // itself. But it appends ONLY `.exe`, so the rest of PATHEXT does not
    // resolve, and that boundary is exactly what these three assertions fix in
    // place.
    const bare = open({ argv: ["cmd", "/c", "echo", "NOEXT-OK"], env: process.env });
    const b = collect(bare);
    await withTimeout(b.exit, 15000);
    ok(b.text().includes("NOEXT-OK"), "a bare `cmd` resolves — CreateProcessW appends .exe");

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
                { encoding: "utf8" },
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
