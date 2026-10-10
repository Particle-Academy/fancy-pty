import { describe, expect, it } from "vitest";

import {
    FrameDecoder,
    HEADER_BYTES,
    MAX_FRAME_BYTES,
    Request,
    clampDimension,
    encodeResize,
    encodeSpawn,
    frame,
} from "../protocol.js";

/**
 * The protocol is the only pure part of this package, so it is the part a unit
 * suite can hold completely — and it is where a version skew between the JS
 * side and the helper would appear as corruption rather than as an error.
 *
 * The helper's own half of the contract (the SPAWN decoder, the Windows
 * command-line join) is covered by `fancy-pty-helper --selftest`, which the
 * build runs: those are the two pieces a reader cannot verify by eye, and they
 * live in Rust where vitest cannot reach.
 */

describe("SPAWN encoding", () => {
    it("round-trips the fields the helper reads back, in order", () => {
        const buf = encodeSpawn({
            argv: ["cmd.exe", "/c", "echo hi"],
            cwd: "C:\\tmp",
            env: { FOO: "bar" },
            cols: 120,
            rows: 30,
        });

        let at = 0;
        expect(buf.readUInt16LE(at)).toBe(120);
        at += 2;
        expect(buf.readUInt16LE(at)).toBe(30);
        at += 2;

        const cwdLen = buf.readUInt32LE(at);
        at += 4;
        expect(buf.subarray(at, at + cwdLen).toString("utf8")).toBe("C:\\tmp");
        at += cwdLen;

        expect(buf.readUInt32LE(at)).toBe(3);
        at += 4;
        for (const want of ["cmd.exe", "/c", "echo hi"]) {
            const n = buf.readUInt32LE(at);
            at += 4;
            expect(buf.subarray(at, at + n).toString("utf8")).toBe(want);
            at += n;
        }

        expect(buf.readUInt32LE(at)).toBe(1);
        at += 4;
        const kLen = buf.readUInt32LE(at);
        at += 4;
        expect(buf.subarray(at, at + kLen).toString("utf8")).toBe("FOO");
        at += kLen;
        const vLen = buf.readUInt32LE(at);
        at += 4;
        expect(buf.subarray(at, at + vLen).toString("utf8")).toBe("bar");
        at += vLen;

        // The helper REJECTS a SPAWN with trailing bytes, treating it as
        // version skew. So an encoder that over-writes is not a harmless
        // inefficiency — it is a hard failure on the other side.
        expect(at).toBe(buf.length);
    });

    it("counts BYTES, not characters, for non-ASCII", () => {
        // The length prefix is a byte count. Using `string.length` would
        // under-run every multi-byte path and cwd, and the symptom would be a
        // pty that fails only for users whose home directory has an accent in
        // it — a bug that survives every test written on an ASCII machine.
        const buf = encodeSpawn({ argv: ["é"], cols: 1, rows: 1 });
        const argLen = buf.readUInt32LE(2 + 2 + 4 + 4);
        expect(argLen).toBe(2);
        expect("é".length).toBe(1); // the value a naive encoder would have used
    });

    it("drops undefined env values rather than stringifying them", () => {
        // `process.env` is full of `string | undefined` in TypeScript's view,
        // and "undefined" as a literal value makes a shell behave strangely for
        // one user only.
        const buf = encodeSpawn({ argv: ["sh"], env: { A: "1", B: undefined, C: "3" } });
        let at = 2 + 2;
        at += 4 + buf.readUInt32LE(at); // cwd
        const argc = buf.readUInt32LE(at);
        at += 4;
        for (let i = 0; i < argc; i++) {
            at += 4 + buf.readUInt32LE(at);
        }
        expect(buf.readUInt32LE(at)).toBe(2);
    });

    it("refuses an empty argv instead of spawning nothing", () => {
        expect(() => encodeSpawn({ argv: [] })).toThrow(/non-empty/);
    });
});

describe("dimensions", () => {
    it("clamps rather than throwing", () => {
        // A transient 0 arrives from layout code during mount. Refusing to open
        // the pty over it would be worse than opening a 1-column one.
        expect(clampDimension(0)).toBe(1);
        expect(clampDimension(-5)).toBe(1);
        expect(clampDimension(NaN)).toBe(1);
        expect(clampDimension(80.7)).toBe(80);
        // COORD carries an i16, so anything above its range would wrap to a
        // NEGATIVE size on the other side.
        expect(clampDimension(99999)).toBe(32767);
    });

    it("encodes a resize as exactly four bytes, which the helper requires", () => {
        const b = encodeResize(110, 45);
        expect(b.length).toBe(4);
        expect(b.readUInt16LE(0)).toBe(110);
        expect(b.readUInt16LE(2)).toBe(45);
    });
});

describe("FrameDecoder", () => {
    const framed = (kind: number, body: string) => {
        const payload = Buffer.from(body, "utf8");
        const head = Buffer.allocUnsafe(HEADER_BYTES);
        head[0] = kind;
        head.writeUInt32LE(payload.length, 1);
        return Buffer.concat([head, payload]);
    };

    it("reassembles a frame split across chunks", () => {
        const d = new FrameDecoder();
        const whole = framed(0x81, "hello world");
        // Byte at a time: the worst case a pipe can hand us, and the one a
        // decoder that assumes chunk == frame gets wrong silently.
        const seen = [];
        for (const byte of whole) {
            seen.push(...d.push(Buffer.from([byte])));
        }
        expect(seen).toHaveLength(1);
        expect(seen[0]!.payload.toString()).toBe("hello world");
        expect(d.buffered).toBe(0);
    });

    it("returns EVERY frame when several arrive in one chunk", () => {
        // The other half, and the one that drops data rather than truncating
        // it: a decoder handling only the first frame per chunk loses the rest
        // under load, which reads as a rendering glitch.
        const d = new FrameDecoder();
        const got = d.push(
            Buffer.concat([framed(0x81, "one"), framed(0x81, "two"), framed(0x81, "three")]),
        );
        expect(got.map((f) => f.payload.toString())).toEqual(["one", "two", "three"]);
    });

    it("holds a partial frame back and reports how much", () => {
        const d = new FrameDecoder();
        const whole = framed(0x81, "incomplete");
        expect(d.push(whole.subarray(0, 8))).toHaveLength(0);
        // Non-zero buffered at EOF is how the consumer learns the helper died
        // mid-frame, instead of reporting a clean exit.
        expect(d.buffered).toBe(8);
        expect(d.push(whole.subarray(8))).toHaveLength(1);
        expect(d.buffered).toBe(0);
    });

    it("copies the payload, so reuse of the source chunk cannot corrupt it", () => {
        // `subarray` returns a VIEW over the caller's chunk. Node's stream
        // reads come out of a POOLED allocator, so a chunk's backing memory can
        // be written again by a later read — which would silently rewrite
        // terminal output that has already been delivered. The hardest possible
        // version of this bug to trace, and invisible unless the test actually
        // writes to the source.
        //
        // THE FIRST VERSION OF THIS TEST ASSERTED THE RIGHT THING AND PROVED
        // NOTHING: it pushed a second frame and re-read the first payload.
        // Replacing the copy with a bare view still passed, because
        // `Buffer.concat` allocates fresh and never touches the original. The
        // assertion was correct; the scenario could not produce the condition.
        const d = new FrameDecoder();
        const chunk = framed(0x81, "stable");
        const [f] = d.push(chunk);
        chunk.fill(0x58, HEADER_BYTES); // the pool hands this memory out again
        expect(f!.payload.toString()).toBe("stable");
    });

    it("rejects an over-cap length instead of allocating against it", () => {
        const d = new FrameDecoder();
        const head = Buffer.allocUnsafe(HEADER_BYTES);
        head[0] = 0x81;
        head.writeUInt32LE(MAX_FRAME_BYTES + 1, 1);
        expect(() => d.push(head)).toThrow(/over cap/);
    });

    it("preserves arbitrary binary payloads, including NULs", () => {
        // Terminal output is not text. A codec that round-trips through a
        // string would corrupt escape sequences and any binary a program
        // prints, and the failure would look like a font problem.
        const payload = Buffer.from([0x00, 0x1b, 0x5b, 0x41, 0xff, 0x00, 0x7f]);
        const head = Buffer.allocUnsafe(HEADER_BYTES);
        head[0] = 0x81;
        head.writeUInt32LE(payload.length, 1);
        const d = new FrameDecoder();
        const [f] = d.push(Buffer.concat([head, payload]));
        expect(Buffer.compare(f!.payload, payload)).toBe(0);
    });
});

describe("frame()", () => {
    it("writes the 5-byte header the helper expects", () => {
        const f = frame(Request.Data, Buffer.from("abc"));
        expect(f[0]).toBe(0x01);
        expect(f.readUInt32LE(1)).toBe(3);
        expect(f.subarray(5).toString()).toBe("abc");
    });

    it("carries an empty payload, which is what KILL is", () => {
        const f = frame(Request.Kill, Buffer.alloc(0));
        expect(f.length).toBe(HEADER_BYTES);
        expect(f.readUInt32LE(1)).toBe(0);
    });
});
