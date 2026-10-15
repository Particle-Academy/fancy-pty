import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { helperPath, isSupported, packageRoot, platformKey, unpackedPath } from "./helper-path.js";
import {
    FrameDecoder,
    Request,
    Response,
    encodeResize,
    encodeSpawn,
    frame,
    type SpawnRequest,
} from "./protocol.js";

/**
 * The public surface, held to the six meanings `genie2`'s own `PtyPort` already
 * wraps: `open` / `write` / `resize` / `kill`, plus the `data` / `exit`
 * subscriptions. Confirmed with `claude · tynn` 2026-10-10 before any of this
 * was written, so dropping in underneath `fancy-term-host`'s in-process backend
 * changes nothing for them.
 *
 * `onError` is additional rather than a seventh verb — it carries faults that
 * node-pty had no way to report at all, and a consumer that ignores it sees
 * exactly the behaviour it has today.
 */
export interface Pty {
    /** The HELPER's pid, not the shell's. Useful for a teardown sweep. */
    readonly pid: number | undefined;
    readonly exited: boolean;
    readonly exitCode: number | null;
    write(data: string | Buffer): boolean;
    resize(cols: number, rows: number): boolean;
    kill(): boolean;
    onData(listener: (chunk: Buffer) => void): void;
    onExit(listener: (code: number) => void): void;
    onError(listener: (error: Error) => void): void;
}

export interface PtyOptions extends SpawnRequest {
    /** Override the helper binary. For tests and unusual packaging only. */
    helper?: string;
}

/**
 * Open a PTY. One PTY, one helper process.
 *
 * **That one-process-per-pty shape is the whole point of this package, and it
 * is a property rather than a promise.** Renaissance-Analytics/genie#805: a
 * long-lived Node process holding `node-pty` reached 88,346 MB private bytes,
 * 78,996 handles and 7,209 threads for ~41 live terminals against 7,158 spawns
 * — about 12 MB, 1 thread and 11 handles retained per EXITED pty, until the
 * machine ran out of commit memory at 194.6 of 196.2 GB. When a separate helper
 * exits, the OS reclaims its commit, threads and handles whether or not our
 * code is tidy. No amount of care in this file could offer the same guarantee.
 *
 * Returns as soon as the helper is spawned, not once the shell has produced
 * output — the same contract `node-pty` has, so nothing downstream changes.
 */
export function open(options: PtyOptions): Pty {
    const exe = options.helper ?? helperPath();

    if (!options.helper && !isSupported()) {
        throw new Error(
            `fancy-pty: no helper is shipped for ${platformKey()}. ` +
                `Supported: win32/darwin/linux on x64 and arm64.`,
        );
    }
    if (!existsSync(exe)) {
        // Checked up front and named precisely, because the alternative is a
        // spawn ENOENT that reads like the SHELL is missing.
        //
        // THREE causes, and they need three different answers — one message
        // covering all of them would send two thirds of readers the wrong way.
        // The `bin/` directory is `.gitignore`d on purpose (six per-platform
        // binaries would make every clone carry five it cannot run), and the
        // publish workflow assembles them from native runners. So an install
        // from GIT or a source checkout has NO binaries at all, and blaming
        // `asarUnpack` there would be a confidently wrong diagnosis.
        // `unpackedPath` here too, or this diagnostic lies in an Electron app:
        // `packageRoot()` resolves inside `app.asar` and the real `bin/` is in
        // `app.asar.unpacked`. Reading the archive path through Electron's
        // PATCHED `fs` can even succeed, so an un-rewritten binRoot produces a
        // confident message about the wrong directory.
        const binRoot = unpackedPath(path.join(packageRoot(), "bin"));
        const platforms = existsSync(binRoot) ? readdirSync(binRoot) : [];

        if (platforms.length === 0) {
            throw new Error(
                `fancy-pty: no helper binaries are present (${binRoot} is empty or absent). ` +
                    `bin/ is gitignored and the binaries are built per-platform at publish ` +
                    `time, so a git or source install carries none: run 'npm run build:helper' ` +
                    `in the package, or install it from the npm registry.`,
            );
        }
        if (!platforms.includes(platformKey())) {
            throw new Error(
                `fancy-pty: no helper for ${platformKey()}. ` +
                    `This install has: ${platforms.join(", ")}.`,
            );
        }
        // Only now is asarUnpack a fair accusation: the per-platform directory
        // exists and this exact file does not. Said carefully, because an
        // earlier version offered this advice for a problem the consumer did
        // not have — their `asarUnpack` was correct and the path we BUILT named
        // the archive instead of the unpacked tree.
        throw new Error(
            `fancy-pty: helper not found at ${exe}, though ${binRoot} exists. ` +
                `If this is a packaged Electron app, check that ` +
                `'**/node_modules/@particle-academy/fancy-pty/bin/**' is in asarUnpack — ` +
                `a binary inside an asar archive has no path the OS can execute, and ` +
                `child_process.spawn is not redirected the way fs reads are.`,
        );
    }

    /**
     * `spawn` fails two different ways and only one of them is an event.
     *
     * Measured: a DIRECTORY or a nonexistent path emits an async `error`
     * (ENOENT); a non-executable FILE throws SYNCHRONOUSLY (EFTYPE on
     * Windows). The async half is handled by `onError` plus the unheard-error
     * fallback below. The sync half propagates to the caller already — but as
     * a bare `spawn EFTYPE` naming neither this package nor the path, and the
     * person reading it is debugging someone else's library.
     */
    let child: ChildProcess;
    try {
        child = spawn(exe, [], {
            // The helper's own stdio IS the protocol: stdin carries control
            // frames, stdout carries pty output, and stderr stays
            // human-readable so a helper that dies badly can still say why
            // without corrupting the stream the consumer is parsing.
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
    } catch (e) {
        const err = e as NodeJS.ErrnoException;
        throw new Error(
            `fancy-pty: could not start the helper at ${exe} (${err.code ?? err.message}). ` +
                `The file exists but is not an executable image for this platform.`,
            { cause: e },
        );
    }

    const listeners: {
        data: ((c: Buffer) => void)[];
        exit: ((code: number) => void)[];
        error: ((e: Error) => void)[];
    } = { data: [], exit: [], error: [] };

    const emit = <K extends keyof typeof listeners>(
        what: K,
        arg: Parameters<(typeof listeners)[K][number]>[0],
    ): void => {
        /**
         * AN UNHEARD `error` GOES TO stderr. (#1)
         *
         * A spawn failure is the most diagnosable moment this package has and
         * it had the worst reporting: `onError` is the only channel, and
         * `fancy-term-host` forwards it into the TERMINAL stream — correct for
         * a pty that opened and then broke, useless for one that never opened,
         * because there is no terminal to render into. In a packaged Electron
         * app that left `pid -1` and nothing else; `claude · tynn` diagnosed
         * the asar bug from the SHAPE of the failure rather than from anything
         * this library said.
         *
         * This is Node's own convention for an unhandled `error`: do not
         * swallow it. It deliberately does NOT throw the way EventEmitter does
         * — crashing an Electron main process over one failed terminal is worse
         * than a loud line — and it checks at EMIT time, not at `open()` time,
         * so a caller that registers `onError` immediately after `open()`
         * returns is never second-guessed.
         *
         * The alternative fixes all changed `open()`'s contract, which is
         * deliberately node-pty-shaped so consumers need no adapter change.
         * This one changes nothing a caller can observe except that a fault
         * nobody listened for becomes visible.
         */
        if (what === "error" && listeners.error.length === 0) {
            const err = arg as Error;
            process.stderr.write(
                `[fancy-pty] unhandled error (no onError listener): ${err?.message ?? String(arg)}\n`,
            );
        }

        for (const fn of listeners[what] as ((a: unknown) => void)[]) {
            try {
                fn(arg);
            } catch (e) {
                // A throwing consumer callback must not take down the pty or
                // stall the pump, and the remaining listeners still get the
                // event. Swallowing it silently would be worse, so it surfaces
                // as a process warning.
                process.emitWarning(
                    `fancy-pty: a '${what}' listener threw: ${
                        e instanceof Error ? e.message : String(e)
                    }`,
                );
            }
        }
    };

    const decoder = new FrameDecoder();
    let exited = false;
    let exitCode: number | null = null;
    let stderrText = "";

    child.stdout?.on("data", (chunk: Buffer) => {
        let frames;
        try {
            frames = decoder.push(chunk);
        } catch (e) {
            emit("error", e instanceof Error ? e : new Error(String(e)));
            child.kill();
            return;
        }
        for (const f of frames) {
            if (f.kind === Response.Data) {
                emit("data", f.payload);
            } else if (f.kind === Response.Exit) {
                exited = true;
                exitCode = f.payload.readUInt32LE(0);
                emit("exit", exitCode);
            } else if (f.kind === Response.Error) {
                emit("error", new Error(f.payload.toString("utf8")));
            } else {
                emit("error", new Error(`fancy-pty: unknown frame type 0x${f.kind.toString(16)}`));
            }
        }
    });

    child.stderr?.on("data", (c: Buffer) => {
        stderrText += c.toString("utf8");
    });

    /**
     * The async half of a failed spawn names the package and the path too. On
     * POSIX a non-executable file is NOT a synchronous throw (that is Windows'
     * EFTYPE) but an `error` event (EACCES), and a missing path is ENOENT on
     * every platform; before `spawn` fires, such an error is "could not start
     * the helper", worded like the synchronous one. After it, an error is the
     * running helper's and passes through as it is.
     */
    let started = false;
    child.once("spawn", () => {
        started = true;
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
        if (started) return emit("error", e);
        emit("error", new Error(`fancy-pty: could not start the helper at ${exe} (${e.code ?? e.message}).`, { cause: e }));
    });

    /**
     * THE HELPER'S STDIN HAS AN `error` LISTENER — a write to a helper that is
     * already gone must never become an uncaught exception.
     *
     * Measured on the installed Genie 2 (genie-test-ubuntu, 2026-10-15): the
     * front door's Caddy, an unprivileged process, could not bind its port,
     * said so, and exited; the helper
     * forwarded those words as a Data frame and exited too. Genie read the words
     * and asked for a stop — `kill()` — in the same tick, BEFORE the Exit frame
     * or `close` had been processed, so `exited` was still false and `send`
     * wrote the Kill frame into a pipe whose reader was dead. Node reports that
     * write's EPIPE asynchronously, as an `error` EVENT on `child.stdin`; with no
     * listener it is thrown from `process.nextTick`. In Electron that is the
     * main-process "A JavaScript error occurred" box — a synchronous GTK
     * dialog (`gtk_dialog_run`) on the main thread. Genie's window, its
     * DevTools endpoint and every agent and site it supervises stopped
     * answering until someone clicked a box nobody could see.
     *
     * The `exited`/`writable` guard in `send` cannot close this: the reader's
     * death is only known from the write that fails. So the error is HEARD:
     * EPIPE (and a write to an already-destroyed stream) means the helper is
     * gone, which `close` — or the Exit frame — reports with what actually
     * happened; anything else is a real fault and goes to `onError` like every
     * other one (and to stderr when nobody listens, #1). Never a throw.
     */
    child.stdin?.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EPIPE" || e.code === "ERR_STREAM_DESTROYED") return;
        emit("error", e);
    });

    /**
     * Two independent signals for one event, deliberately.
     *
     * If the helper dies without emitting EXIT — a crash, a SIGKILL, a
     * packaging fault — the process exit still closes the terminal, and says
     * what it actually observed rather than reporting a clean exit nobody saw.
     * Keying cleanup on the frame alone is how a dead pty becomes a terminal
     * that never closes, and the consumer cannot tell that from a shell sitting
     * idle at a prompt.
     */
    /**
     * `close`, NOT `exit` — and this is a correctness bug CI caught, not a
     * preference.
     *
     * Node's `exit` fires when the process ends, which can be BEFORE its stdio
     * streams have been drained. So on a fast platform the process-exit
     * fallback below can win the race against the final stdout chunk, and a pty
     * that completed perfectly reports an error with its output thrown away.
     *
     * It passed on Windows because a spawn there costs ~56 ms and the data is
     * long since delivered. On Linux a whole pty lifecycle takes **2 ms**, and
     * `test/live/pty.live.mjs` case 5 — the only case with no `sleep` before
     * reading — failed there and only there. A race that one platform hides is
     * the reason the live suite runs on all of them.
     *
     * `close` is emitted only after every stdio stream is closed, so any EXIT
     * frame still in flight has already been decoded by then.
     */
    child.on("close", (code, signal) => {
        if (exited) return;
        exited = true;
        exitCode = code ?? 1;
        const buffered = decoder.buffered;
        emit(
            "error",
            new Error(
                `fancy-pty: helper exited without reporting (code=${code} signal=${signal})` +
                    (buffered > 0 ? `, mid-frame with ${buffered} bytes buffered` : "") +
                    (stderrText.trim() ? `: ${stderrText.trim()}` : ""),
            ),
        );
        emit("exit", exitCode);
    });

    const send = (buf: Buffer): boolean => {
        const stdin = child.stdin;
        if (exited || !stdin || stdin.destroyed || !stdin.writable) return false;
        stdin.write(buf);
        return true;
    };

    send(frame(Request.Spawn, encodeSpawn(options)));

    return {
        get pid() {
            return child.pid;
        },
        get exited() {
            return exited;
        },
        get exitCode() {
            return exitCode;
        },
        write(data) {
            return send(
                frame(Request.Data, Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8")),
            );
        },
        resize(cols, rows) {
            return send(frame(Request.Resize, encodeResize(cols, rows)));
        },
        kill() {
            return send(frame(Request.Kill, Buffer.alloc(0)));
        },
        onData(fn) {
            listeners.data.push(fn);
        },
        onExit(fn) {
            // A consumer that subscribes AFTER the pty already exited would
            // otherwise wait forever for an event that has been and gone. This
            // is a real ordering: `open()` is synchronous and a failed spawn
            // reports immediately.
            if (exited && exitCode !== null) {
                const code = exitCode;
                queueMicrotask(() => fn(code));
                return;
            }
            listeners.exit.push(fn);
        },
        onError(fn) {
            listeners.error.push(fn);
        },
    };
}
