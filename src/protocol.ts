/**
 * The wire protocol between the JS side and the per-pty helper executable.
 *
 * Kept in its own module because it is the only part of this package that is
 * PURE — no processes, no platform, no timing. That makes it the part a unit
 * suite can actually hold, and it is where a version skew between the two sides
 * would show up as corruption rather than as an error. Everything here is
 * exercised by `src/__tests__/protocol.test.ts`.
 *
 * Frame layout:
 *
 *     [type: u8][len: u32 LE][payload: len bytes]
 *
 * No escaping, no delimiters, no text parsing on either side. Deliberate: the
 * alternative — multiplexing control messages onto a raw stdin stream — makes
 * every byte of terminal input something that might need escaping, which is a
 * defect class we would be inventing for ourselves.
 */

import path from "node:path";

/** JS -> helper. `Spawn` must be the first frame, and there is exactly one. */
export const enum Request {
    Spawn = 0x00,
    Data = 0x01,
    Resize = 0x02,
    Kill = 0x03,
}

/** helper -> JS. `Exit` is always last, and the helper then exits. */
export const enum Response {
    Data = 0x81,
    Exit = 0x82,
    Error = 0x83,
    /** `[pid: u32 LE]` — the COMMAND's pid, sent once, before any `Data`. */
    Pid = 0x84,
    /** `[how: u8]` — 0 graceful, 1 forced. Sent just before `Exit`, only if a kill ended the pty. */
    Killed = 0x85,
}

/** How a `kill()` ended a pty. */
export type KillOutcome = "graceful" | "forced";

/** The `Killed` frame's payload byte, decoded. Unknown values are `null`, never guessed. */
export function decodeKilled(payload: Buffer): KillOutcome | null {
    if (payload.length < 1) return null;
    if (payload[0] === 0) return "graceful";
    if (payload[0] === 1) return "forced";
    return null;
}

/**
 * `KILL`'s payload. No grace (absent, zero, negative, not a number) is the
 * EMPTY payload — byte-for-byte the 0.1.x frame, so it means exactly what it
 * meant: a hard kill, now. A grace is `[graceMs: u32 LE]`, clamped to u32
 * (so `Infinity` is ~49 days, not a hard kill).
 */
export function encodeKill(graceMs?: number): Buffer {
    if (graceMs === undefined || Number.isNaN(graceMs) || graceMs <= 0) return Buffer.alloc(0);
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(Math.min(0xffff_ffff, Math.ceil(graceMs)), 0);
    return b;
}

export const HEADER_BYTES = 5;

/**
 * A frame cap, because a length prefix read off a pipe is attacker-shaped data
 * even when the peer is our own helper. 64 MiB is far above any real terminal
 * write and far below anything that threatens the process.
 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface SpawnRequest {
    /**
     * The program and its arguments, as a LIST — never a command line.
     *
     * Windows' `CreateProcessW` wants a single string, and the quoting rules
     * for producing one are a documented minefield (backslash runs before a
     * quote, `cmd.exe`'s second parse). The helper owns that join, in one
     * place, where it is tested. A consumer must never have to know the rules.
     */
    argv: string[];
    cwd?: string;
    /**
     * The child's complete environment. Passed explicitly rather than merged
     * with the helper's own, so a pty's environment is exactly what the caller
     * asked for — a helper that silently added its own would make terminal
     * behaviour depend on how the APP was launched, which is invisible from the
     * consumer's side and very hard to reproduce.
     */
    env?: Record<string, string | undefined>;
    cols?: number;
    rows?: number;
    /**
     * WINDOWS: pass the arguments to the command line exactly as written,
     * joined with single spaces — Node's `child_process` option of the same
     * name. For running a shell line, where `cmd.exe` cannot read the `\"` that
     * the default quoting produces. Ignored on POSIX, as in Node. Default `false`.
     *
     * **All quoting becomes the caller's, so untrusted text in `argv` is command
     * injection.** `argv[0]` stays the program name and is quoted for you if it
     * has whitespace, so it cannot resolve to the wrong program (unlike Node's,
     * it is not sent raw); a `"` in it is refused. See the README.
     *
     * It is also what lifts the refusal of a `.cmd` or `.bat` argument that
     * `cmd.exe` would act on. On POSIX, where it is otherwise ignored, it lifts
     * that refusal too.
     */
    windowsVerbatimArguments?: boolean;
}

/**
 * Would Windows run this program through `cmd.exe`? Judged from the name, so the
 * answer is the same on every OS.
 *
 * Normalised first, because Windows does: `x.cmd.`, `x.cmd `, `x.cmd\.` and
 * `x.cmd\y\..` all run `x.cmd`, and a plain suffix check passes every one of them.
 * The helper makes the same call on Windows from the path it actually resolved,
 * which is the authority. This one exists so a developer on any OS finds out, and
 * so nothing starts on a request that is going to be refused.
 */
export function isBatchProgram(program: string): boolean {
    const name = path.win32.normalize(program).replace(/[\\/. ]+$/, "");
    return /\.(cmd|bat)$/i.test(name);
}

/** What `cmd.exe` acts on in an argument, each one measured. See the README. */
const CMD_ACTS_ON = /[&|<>^%"!\r\n]/;

/** Printable ASCII only, cut to `limit`: an error must not carry someone's text whole. */
function preview(text: string, limit: number): string {
    const chars = Array.from(text);
    const shown = chars
        .slice(0, limit)
        .map((c) => (c >= " " && c <= "~" ? c : "?"))
        .join("");
    return chars.length > limit ? `"${shown}..."` : `"${shown}"`;
}

/**
 * Why this request must be refused, or `null` if it is fine.
 *
 * Windows runs a `.cmd` or `.bat` as `cmd.exe /c <line>` whatever the caller asked
 * for, and `cmd.exe` parses that line itself, so an `&` in an argument runs a second
 * command. On Linux and macOS a `.cmd` is not a batch file and has no such risk: it
 * is refused there too so that code behaves the same everywhere, and a developer on
 * a Mac finds this before it reaches a Windows user. The helper has the same check
 * and the same wording, `batch_argument_refusal` in `native/helper.rs`.
 *
 * `windowsVerbatimArguments` is exempt: the caller owns the quoting there.
 */
export function batchArgumentRefusal(argv: string[], verbatim?: boolean): string | null {
    const [program = "", ...args] = argv;
    if (verbatim === true || !isBatchProgram(program)) return null;
    for (const [i, arg] of args.entries()) {
        const found = CMD_ACTS_ON.exec(arg)?.[0];
        if (found === undefined) continue;
        const what = found === "\n" ? "a line feed" : found === "\r" ? "a carriage return" : `"${found}"`;
        return (
            `fancy-pty: refusing to start the batch file ${preview(program, 60)}: ` +
            `argv[${i + 1}] (${preview(arg, 12)}) contains ${what}, which cmd.exe acts on. ` +
            `Windows runs every .cmd and .bat through cmd.exe, so this argument could run another command. ` +
            `Refused on every OS, so the same code behaves the same everywhere. ` +
            `Pass plain arguments, or set windowsVerbatimArguments: true and quote it yourself, ` +
            `and never with text you did not write.`
        );
    }
    return null;
}

/** SPAWN's `[flags: u32 LE]` trailer. See `native/proto.md`. */
const SPAWN_FLAG_WINDOWS_VERBATIM = 1;

function u32(value: number): Buffer {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(value, 0);
    return b;
}

function lengthPrefixed(s: string): Buffer {
    const body = Buffer.from(s, "utf8");
    return Buffer.concat([u32(body.length), body]);
}

/**
 * `[cols u16][rows u16][cwd str][argc u32][argv…][envc u32][k,v…]`, then
 * `[flags u32]` only if a flag is set: a default spawn stays byte-identical to
 * 0.2.1, and a helper too old to know a flag rejects the trailing bytes.
 */
export function encodeSpawn(req: SpawnRequest): Buffer {
    if (!Array.isArray(req.argv) || req.argv.length === 0) {
        throw new TypeError("fancy-pty: argv must be a non-empty array");
    }
    const verbatim = req.windowsVerbatimArguments;
    if (verbatim != null && typeof verbatim !== "boolean") {
        throw new TypeError("fancy-pty: windowsVerbatimArguments must be a boolean");
    }

    const size = Buffer.allocUnsafe(4);
    size.writeUInt16LE(clampDimension(req.cols ?? 80), 0);
    size.writeUInt16LE(clampDimension(req.rows ?? 24), 2);

    const parts: Buffer[] = [size, lengthPrefixed(req.cwd ?? "")];

    parts.push(u32(req.argv.length));
    for (const arg of req.argv) {
        parts.push(lengthPrefixed(arg));
    }

    // `undefined` values are dropped rather than stringified. `process.env` is
    // full of them in TypeScript's view, and "undefined" as a literal value is
    // the kind of thing that makes a shell behave strangely for one user only.
    const entries = Object.entries(req.env ?? {}).filter(
        (e): e is [string, string] => e[1] !== undefined,
    );
    parts.push(u32(entries.length));
    for (const [k, v] of entries) {
        parts.push(lengthPrefixed(k), lengthPrefixed(v));
    }

    if (verbatim === true) {
        parts.push(u32(SPAWN_FLAG_WINDOWS_VERBATIM));
    }

    return Buffer.concat(parts);
}

/**
 * Dimensions are clamped, not validated-and-thrown.
 *
 * A terminal told to be 0 columns is a caller bug, but refusing to open the pty
 * over it is worse than opening a 1-column one: a resize arrives from layout
 * code during mount and transient zeroes are normal there. `i16` is the ceiling
 * because that is what `COORD` carries.
 */
export function clampDimension(n: number): number {
    if (!Number.isFinite(n)) return 1;
    return Math.min(32767, Math.max(1, Math.trunc(n)));
}

export function encodeResize(cols: number, rows: number): Buffer {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt16LE(clampDimension(cols), 0);
    b.writeUInt16LE(clampDimension(rows), 2);
    return b;
}

export function frame(kind: Request, payload: Buffer): Buffer {
    const head = Buffer.allocUnsafe(HEADER_BYTES);
    head[0] = kind;
    head.writeUInt32LE(payload.length, 1);
    return Buffer.concat([head, payload]);
}

export interface DecodedFrame {
    kind: number;
    payload: Buffer;
}

/**
 * Incremental decoder for the helper's stdout.
 *
 * A frame can arrive split across any number of reads, and several frames can
 * arrive in one. Both halves matter: handling only the first gives silent
 * truncation under load, and handling only the second drops everything after
 * the first frame in a chunk. Either shows up as a rendering glitch rather than
 * a protocol error, which is why this is a named class with its own tests
 * instead of a loop inlined in the data handler.
 */
export class FrameDecoder {
    private pending: Buffer = Buffer.alloc(0);

    push(chunk: Buffer): DecodedFrame[] {
        this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);

        const frames: DecodedFrame[] = [];
        for (;;) {
            if (this.pending.length < HEADER_BYTES) break;
            const kind = this.pending[0]!;
            const len = this.pending.readUInt32LE(1);
            if (len > MAX_FRAME_BYTES) {
                throw new Error(`fancy-pty: frame length ${len} over cap`);
            }
            if (this.pending.length < HEADER_BYTES + len) break;
            frames.push({
                kind,
                // `subarray` is a view, so copy: the payload outlives this call
                // and `pending` is reassigned underneath it.
                payload: Buffer.from(this.pending.subarray(HEADER_BYTES, HEADER_BYTES + len)),
            });
            this.pending = this.pending.subarray(HEADER_BYTES + len);
        }
        return frames;
    }

    /**
     * Bytes held back awaiting the rest of a frame. Non-zero at EOF means the
     * helper died mid-frame, which is worth reporting rather than ignoring.
     */
    get buffered(): number {
        return this.pending.length;
    }
}
