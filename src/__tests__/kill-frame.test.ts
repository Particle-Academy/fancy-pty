import { describe, expect, it } from "vitest";

import { decodeKilled, encodeKill } from "../protocol.js";

/**
 * F4's wire half. The live half (a worker actually finishing its job) is in
 * `test/live/lifecycle.live.mjs`; this pins the bytes, and in particular that
 * the 0.1.x call still sends the 0.1.x frame.
 */
describe("KILL encoding", () => {
    it("kill() with no grace sends the EMPTY payload — the 0.1.x hard kill, byte for byte", () => {
        expect(encodeKill()).toHaveLength(0);
        expect(encodeKill(0)).toHaveLength(0);
        expect(encodeKill(-5)).toHaveLength(0);
        expect(encodeKill(Number.NaN)).toHaveLength(0);
    });

    it("a grace is [graceMs: u32 LE]", () => {
        const b = encodeKill(10_000);
        expect(b).toHaveLength(4);
        expect(b.readUInt32LE(0)).toBe(10_000);
    });

    it("rounds a fractional grace UP, so 0.5 ms never becomes a hard kill", () => {
        expect(encodeKill(0.5).readUInt32LE(0)).toBe(1);
    });

    it("clamps to u32 rather than wrapping into a short grace", () => {
        expect(encodeKill(2 ** 40).readUInt32LE(0)).toBe(0xffff_ffff);
        expect(encodeKill(Number.POSITIVE_INFINITY).readUInt32LE(0)).toBe(0xffff_ffff);
    });
});

describe("KILLED decoding", () => {
    it("0 is graceful, 1 is forced", () => {
        expect(decodeKilled(Buffer.from([0]))).toBe("graceful");
        expect(decodeKilled(Buffer.from([1]))).toBe("forced");
    });

    it("anything else is null, never a guess", () => {
        expect(decodeKilled(Buffer.alloc(0))).toBeNull();
        expect(decodeKilled(Buffer.from([7]))).toBeNull();
    });
});
