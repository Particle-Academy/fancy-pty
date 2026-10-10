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

    const gauge = () => ({
        rss: process.memoryUsage().rss,
        handles: process.report?.getReport?.()?.libuv?.length ?? -1,
    });

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
    await sleep(800);
    const withLive = gauge();
    ok(
        withLive.handles > base.handles,
        `positive control: ${20} live ptys moved libuv handles ${base.handles} -> ${withLive.handles}`,
    );
    for (const p of live) p.kill();
    await Promise.all(live.map((p) => new Promise((r) => p.onExit(r))));
    await sleep(1200);

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
    await sleep(1500);
    if (global.gc) global.gc();
    await sleep(200);
    const after = gauge();

    const perMb = (after.rss - before.rss) / 1024 / 1024 / CYCLES;
    const perHandles = (after.handles - before.handles) / CYCLES;

    console.log(
        `     ${exits}/${CYCLES} exited in ${ms} ms (${Math.round(ms / CYCLES)} ms each)\n` +
            `     rss ${(before.rss / 1e6).toFixed(1)} -> ${(after.rss / 1e6).toFixed(1)} MB   ` +
            `libuv handles ${before.handles} -> ${after.handles}\n` +
            `     per exited pty: ${perMb.toFixed(3)} MB, ${perHandles.toFixed(3)} handles`,
    );

    ok(exits === CYCLES, `every pty exited (${exits}/${CYCLES})`);
    // `claude · tynn`'s thresholds, per exited pty, set so genie#805's numbers
    // (~12 MB, ~11 handles, ~1 thread) fail by 10x and a tidy engine passes
    // with headroom.
    ok(perMb <= 0.5, `retained <= 0.5 MB per exited pty (${perMb.toFixed(3)})`);
    ok(perHandles <= 1.0, `retained <= 1.0 handles per exited pty (${perHandles.toFixed(3)})`);
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
