import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { open } from "../pty.js";

/**
 * A write to a helper that is already gone must never become an uncaught
 * exception.
 *
 * WHY. Measured on the installed Genie 2 (genie-test-ubuntu, 2026-10-15): the
 * front door's Caddy exited after saying it could not bind; Genie read those
 * words and called `kill()` before the Exit frame or `close` arrived, so the
 * Kill frame went into a pipe whose reader was dead. Node reports that EPIPE as
 * an `error` EVENT on `child.stdin`, and with no listener it is thrown from
 * `process.nextTick`. In Electron that throw is the main-process error box — a
 * synchronous `gtk_dialog_run` on the main thread — and the whole app stopped
 * answering for as long as nobody clicked it. The inspector's stack:
 *
 *     Error: write EPIPE
 *       at Writable.write
 *       at send            (fancy-pty/dist/index.cjs:238)
 *       at Object.kill     (fancy-pty/dist/index.cjs:261)
 *       at Object.kill     (fancy-term-host/dist/index.js:74)
 *       at InProcessBackend.kill
 *       at ProcessSupervisor.stop   (genie: the front door's bind-failure watcher)
 *
 * ## The fixture: a helper that closes its stdin and stays alive
 *
 * The race is "the reader is gone, `close` has not fired". A helper that exits
 * outright closes that window in microseconds and makes the test a coin toss.
 * This one closes fd 0 at once and then lives for a second: every write after
 * that is EPIPE, deterministically, while `exited` is still false — exactly the
 * state `kill()` met in the app. POSIX only (a shebang script and `exec 0<&-`).
 *
 * ## The control
 *
 * "No uncaught exception" passes on a run where nothing went wrong at all, so
 * the same fixture is first written to WITHOUT fancy-pty, with a listener, and
 * that write must answer EPIPE — the gauge is shown to see the failure before
 * its absence is trusted.
 */

const posix = process.platform !== "win32";
let dir = "";
let helper = "";
const uncaught: Error[] = [];
const onUncaught = (e: Error) => {
    uncaught.push(e);
};

beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fancy-pty-epipe-"));
    helper = path.join(dir, "gone-helper.sh");
    // Closes its stdin, then stays alive: writes fail, `close` has not happened.
    writeFileSync(helper, "#!/bin/sh\nexec 0<&-\nsleep 1\nexit 0\n");
    chmodSync(helper, 0o755);
    uncaught.length = 0;
    process.on("uncaughtException", onUncaught);
});

afterEach(() => {
    process.off("uncaughtException", onUncaught);
    rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!posix)("a write to a helper whose stdin is gone", () => {
    it("CONTROL: the fixture really answers a write with EPIPE", async () => {
        const child = spawn(helper, [], { stdio: ["pipe", "pipe", "pipe"] });
        const errors: string[] = [];
        child.stdin.on("error", (e: NodeJS.ErrnoException) => errors.push(e.code ?? e.message));
        await sleep(200);
        child.stdin.write(Buffer.from("anything"));
        await new Promise<void>((r) => child.on("close", () => r()));
        expect(errors).toEqual(["EPIPE"]);
    });

    it("kill() on it raises NO uncaught exception, and the pty still reports its exit", async () => {
        const pty = open({ argv: ["irrelevant"], helper });
        const errors: Error[] = [];
        pty.onError((e) => errors.push(e));
        const exited = new Promise<number>((r) => pty.onExit(r));

        await sleep(200);
        // The helper's reader is gone and `close` has not fired: this is the
        // state `kill()` met in the app.
        expect(pty.exited).toBe(false);
        pty.kill();
        pty.write("after the reader died");
        const code = await exited;
        await sleep(50);

        // Counted, not a boolean: on the unfixed send() this is 1 or more.
        expect(uncaught.map((e) => e.message)).toEqual([]);
        // The helper's going is reported the way it always was — by `close` —
        // and the EPIPE itself is not passed off as a fault of its own.
        expect(typeof code).toBe("number");
        expect(errors.filter((e) => /EPIPE/.test(e.message))).toEqual([]);
    });
});
