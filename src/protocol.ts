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
}

function u32(value: number): Buffer {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(value, 0);
    return b;
}

function lengthPrefixed(s: string): Buffer {
    const body = Buffer.from(s, "utf8");
    return Buffer.concat([u32(body.length), body]);
}

/** `[cols u16][rows u16][cwd str][argc u32][argv…][envc u32][k,v…]` */
export function encodeSpawn(req: SpawnRequest): Buffer {
    if (!Array.isArray(req.argv) || req.argv.length === 0) {
        throw new TypeError("fancy-pty: argv must be a non-empty array");
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
