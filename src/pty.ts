import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

import { helperPath, isSupported, platformKey } from "./helper-path.js";
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
        // spawn ENOENT that reads like the SHELL is missing. In a packaged app
        // the real cause is almost always that `bin/` was swallowed by the asar
        // archive, and a message that says so saves the whole investigation.
        throw new Error(
            `fancy-pty: helper not found at ${exe}. In a packaged Electron app, ` +
                `add '**/node_modules/@particle-academy/fancy-pty/bin/**' to asarUnpack — ` +
                `a binary inside an asar archive has no path the OS can execute.`,
        );
    }

    const child: ChildProcess = spawn(exe, [], {
        // The helper's own stdio IS the protocol: stdin carries control frames,
        // stdout carries pty output, and stderr stays human-readable so a
        // helper that dies badly can still say why without corrupting the
        // stream the consumer is parsing.
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });

    const listeners: {
        data: ((c: Buffer) => void)[];
        exit: ((code: number) => void)[];
        error: ((e: Error) => void)[];
    } = { data: [], exit: [], error: [] };

    const emit = <K extends keyof typeof listeners>(
        what: K,
        arg: Parameters<(typeof listeners)[K][number]>[0],
    ): void => {
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

    child.on("error", (e) => emit("error", e));

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
    child.on("exit", (code, signal) => {
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
