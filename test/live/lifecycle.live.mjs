// LIVE: process LIFETIME — the four asks from Genie 2.0.0-beta.33 (F1-F4).
//
//   F1  a helper does not outlive its controller
//   F2  a helper has no console of its own, and reports the command's pid
//   F3  the job is assigned before the child runs (Windows)
//   F4  kill({ graceMs }) stops gracefully, and says which way it ended
//
// Every check here counts PROCESSES THAT REPORTED THEIR OWN PIDS (see
// fixtures/sleeper.mjs), never processes found by name, and each one opens
// with a positive control: the survivors are counted ALIVE before the event
// that should end them, so a "0 survivors" result cannot come from an
// instrument that sees nothing.
//
// Runs against dist/, like pty.live.mjs, because that is what a consumer gets.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { open, helperPath } from "../../dist/index.js";

const isWindows = process.platform === "win32";
const here = path.dirname(fileURLToPath(import.meta.url));
const sleeper = path.join(here, "fixtures", "sleeper.mjs");
const controllerScript = path.join(here, "fixtures", "controller.mjs");

let failures = 0;
const ok = (cond, what) => {
    console.log(`  ${cond ? "ok  " : "FAIL"} ${what}`);
    if (!cond) failures++;
};

const alive = (pid) => {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === "EPERM";
    }
};

/** Best-effort cleanup so a RED run does not poison the checks after it. */
const reap = (pids) => {
    for (const pid of pids) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {}
    }
};

const tempDir = (tag) => mkdtempSync(path.join(tmpdir(), `fancy-pty-${tag}-`));
const readPid = (dir, name) => {
    const f = path.join(dir, name);
    return existsSync(f) ? Number(readFileSync(f, "utf8")) : undefined;
};

async function waitFor(fn, ms, step = 50) {
    const deadline = Date.now() + ms;
    for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() > deadline) return undefined;
        await sleep(step);
    }
}

const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => "TIMEOUT")]);

/**
 * pid, parent pid and image name for every process. The parent pid survives
 * its parent's death on Windows (it is a stale number, not a link), which is
 * what lets a conhost be attributed to a helper that has already gone.
 */
function processTable() {
    if (isWindows) {
        const out = execFileSync(
            "powershell.exe",
            [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_Process | ForEach-Object { '{0},{1},{2}' -f $_.ProcessId,$_.ParentProcessId,$_.Name }",
            ],
            { encoding: "utf8" },
        );
        return out
            .split(/\r?\n/)
            .filter(Boolean)
            .map((l) => {
                const [pid, ppid, ...name] = l.split(",");
                return { pid: Number(pid), ppid: Number(ppid), name: name.join(",") };
            });
    }
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" });
    return out
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
            const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
            return { pid: Number(m[1]), ppid: Number(m[2]), name: m[3] };
        });
}

const isConhost = (name) => /^(conhost|openconsole)\.exe$/i.test(name);
const conhostsUnder = (table, parents) =>
    table.filter((p) => parents.has(p.ppid) && isConhost(p.name));

function openSleeper(dir, tag, mode = "idle") {
    const pty = open({
        argv: [process.execPath, sleeper, dir, tag, mode],
        cols: 80,
        rows: 24,
        env: process.env,
    });
    pty.onData(() => {});
    const errors = [];
    pty.onError((e) => errors.push(e));
    const exit = new Promise((res) => pty.onExit((code, info) => res({ code, info })));
    return { pty, exit, errors };
}

console.log(`\nfancy-pty lifecycle suite — ${process.platform}-${process.arch}`);
console.log(`helper: ${helperPath()}\n`);

// --------------------------------------------------------------- F2 (b)
console.log("F2b. the pty reports the COMMAND's pid as childPid; pid stays the helper's");
{
    const dir = tempDir("f2b");
    const { pty, exit } = openSleeper(dir, "c");
    const reported = await waitFor(() => readPid(dir, "c.child"), 15000);
    ok(reported !== undefined, `control: the child reported its own pid (${reported})`);
    ok(pty.childPid === reported, `childPid === the command's own pid (${pty.childPid} vs ${reported})`);
    ok(typeof pty.pid === "number" && pty.pid !== reported, `pid is still the helper's (${pty.pid})`);
    pty.kill();
    await withTimeout(exit, 10000);
    reap([reported, readPid(dir, "c.grandchild")]);
}

// --------------------------------------------------------------- F2 (a)
if (isWindows) {
    console.log("\nF2a. a helper owns ONE conhost (the pseudoconsole's), not two");
    const pty = open({ argv: ["cmd.exe"], cols: 80, rows: 24, env: process.env });
    pty.onData(() => {});
    const exit = new Promise((r) => pty.onExit(r));
    await sleep(1500);
    const mine = conhostsUnder(processTable(), new Set([pty.pid]));
    // The control is the pseudoconsole's own conhost: every pty legitimately
    // has one, so seeing ZERO means the instrument is blind, not that we won.
    ok(mine.length >= 1, `control: the pseudoconsole's conhost is visible (${mine.length} under helper ${pty.pid})`);
    ok(mine.length === 1, `exactly 1 conhost per pty — none for the helper itself (${mine.map((p) => p.name).join(", ")})`);
    pty.kill();
    await withTimeout(exit, 10000);
}

// ------------------------------------------------------------------ F3
console.log("\nF3. a grandchild spawned in the child's FIRST instant is still in the tree");
{
    // On Windows the race window between CreateProcessW and the job
    // assignment is microseconds wide, too narrow to hit on demand. The
    // TEST-ONLY delay widens it to 3 s so it is hit EVERY run: if the child
    // runs during that window its grandchild escapes the job, and a kill
    // leaves it alive. POSIX has no window (setsid runs before exec), so the
    // same check there is coverage rather than a regression test.
    const DELAY = 3000;
    if (isWindows) process.env.FANCY_PTY_TEST_ONLY_ASSIGN_DELAY_MS = String(DELAY);
    const dir = tempDir("f3");
    const t0 = Date.now();
    const { pty, exit } = openSleeper(dir, "g");
    if (isWindows) delete process.env.FANCY_PTY_TEST_ONLY_ASSIGN_DELAY_MS;

    const gc = await waitFor(() => readPid(dir, "g.grandchild"), 20000);
    const child = readPid(dir, "g.child");
    ok(alive(gc), `control: the grandchild is running (${gc}) before the kill`);
    // Past the widened window either way, so the kill always lands after the
    // assignment and only the escape is being measured.
    if (isWindows) await sleep(Math.max(0, DELAY + 500 - (Date.now() - t0)));
    pty.kill();
    const r = await withTimeout(exit, 10000);
    ok(r !== "TIMEOUT", "the pty exited after kill()");
    await sleep(1500);
    ok(!alive(child), `the child is gone (${child})`);
    ok(!alive(gc), `the grandchild is gone too — it did not escape the tree (${gc})`);
    reap([child, gc]);
}

// ------------------------------------------------------------------ F4
console.log("\nF4. kill({ graceMs }) lets a worker finish, and reports how it ended");
{
    // (i) graceful: the child takes 1 s to finish its "job" after the signal.
    {
        const dir = tempDir("f4g");
        const { pty, exit } = openSleeper(dir, "w", "graceful");
        await waitFor(() => existsSync(path.join(dir, "w.ready")), 15000);
        const child = readPid(dir, "w.child");
        const gc = readPid(dir, "w.grandchild");
        ok(alive(child), `control: the worker is running (${child})`);
        await sleep(1000);
        const t = Date.now();
        pty.kill({ graceMs: 10000 });
        const r = await withTimeout(exit, 15000);
        const took = Date.now() - t;
        ok(r !== "TIMEOUT", `the pty exited (${took} ms after kill)`);
        ok(existsSync(path.join(dir, "w.done")), "the worker FINISHED its job — it was signalled, not killed");
        ok(pty.killedBy === "graceful", `killedBy === "graceful" (${pty.killedBy})`);
        ok(r !== "TIMEOUT" && r.info?.killedBy === "graceful", `onExit carries killedBy "graceful" (${r?.info?.killedBy})`);
        ok(took < 8000, `it ended on the worker's schedule, not the grace deadline (${took} ms)`);
        await sleep(500);
        ok(!alive(child) && !alive(gc), "0 survivors");
        reap([child, gc]);
    }
    // (ii) forced: a child that ignores the signal is hard-killed at the deadline.
    {
        const dir = tempDir("f4f");
        const { pty, exit } = openSleeper(dir, "s", "stubborn");
        await waitFor(() => existsSync(path.join(dir, "s.ready")), 15000);
        const child = readPid(dir, "s.child");
        const gc = readPid(dir, "s.grandchild");
        ok(alive(child), `control: the stubborn child is running (${child})`);
        const t = Date.now();
        pty.kill({ graceMs: 1500 });
        const r = await withTimeout(exit, 15000);
        const took = Date.now() - t;
        ok(r !== "TIMEOUT", `the pty exited (${took} ms after kill)`);
        ok(pty.killedBy === "forced", `killedBy === "forced" (${pty.killedBy})`);
        ok(took >= 1400, `the grace period was honoured before forcing (${took} ms >= 1500)`);
        await sleep(500);
        ok(!alive(child) && !alive(gc), "0 survivors");
        reap([child, gc]);
    }
    // (iii) the 0.1.x call: kill() with no argument is still immediate.
    {
        const dir = tempDir("f4l");
        const { pty, exit } = openSleeper(dir, "l", "stubborn");
        await waitFor(() => existsSync(path.join(dir, "l.ready")), 15000);
        const child = readPid(dir, "l.child");
        const t = Date.now();
        pty.kill();
        const r = await withTimeout(exit, 15000);
        const took = Date.now() - t;
        ok(r !== "TIMEOUT" && took < 1500, `kill() is still an immediate hard kill (${took} ms)`);
        ok(pty.killedBy === "forced", `and reports killedBy "forced" (${pty.killedBy})`);
        reap([child, readPid(dir, "l.grandchild")]);
    }
}

// ------------------------------------------------------------------ F1
console.log("\nF1. ten ptys do not outlive a controller that is killed outright");
{
    const N = 10;
    const dir = tempDir("f1");
    const ctl = spawn(process.execPath, [controllerScript, dir, String(N)], {
        stdio: ["ignore", "pipe", "inherit"],
    });
    const line = await new Promise((res) => {
        let buf = "";
        ctl.stdout.on("data", (c) => {
            buf += c.toString("utf8");
            const i = buf.indexOf("\n");
            if (i >= 0) res(buf.slice(0, i));
        });
    });
    const { helpers } = JSON.parse(line);
    const tags = Array.from({ length: N }, (_, i) => `p${i}`);
    await waitFor(() => tags.every((t) => existsSync(path.join(dir, `${t}.ready`))), 30000);
    const children = tags.map((t) => readPid(dir, `${t}.child`));
    const grandchildren = tags.map((t) => readPid(dir, `${t}.grandchild`));
    const all = { helpers, children, grandchildren };
    const count = () => Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.filter(alive).length]));

    const helperSet = new Set(helpers);
    const before = count();
    const conBefore = isWindows ? conhostsUnder(processTable(), helperSet).length : null;
    ok(
        before.helpers === N && before.children === N && before.grandchildren === N,
        `control: ${N} helpers, ${N} children, ${N} grandchildren alive (${JSON.stringify(before)})`,
    );
    if (isWindows) {
        ok(conBefore >= N, `control: the helpers' conhosts are visible (${conBefore})`);
    }

    // Outright: no signal handler runs, nothing gets to say goodbye. This is
    // the shape of a crash, not of a quit.
    if (isWindows) execFileSync("taskkill", ["/F", "/PID", String(ctl.pid)], { stdio: "ignore" });
    else process.kill(ctl.pid, "SIGKILL");
    await sleep(2000);

    const after = count();
    const conAfter = isWindows ? conhostsUnder(processTable(), helperSet).length : null;
    console.log(`     2 s after the controller died: ${JSON.stringify(after)}${isWindows ? `, conhosts ${conAfter}` : ""}`);
    ok(after.helpers === 0, `0 helpers survive (${after.helpers})`);
    ok(after.children === 0, `0 children survive (${after.children})`);
    ok(after.grandchildren === 0, `0 grandchildren survive (${after.grandchildren})`);
    if (isWindows) ok(conAfter === 0, `0 ConPTY conhosts survive (${conAfter})`);
    reap([...helpers, ...children, ...grandchildren]);
}

console.log(failures === 0 ? "\nALL GREEN\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
