import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A request `encodeSpawn` refuses must not have started a helper first.
 *
 * `open()` used to spawn and then encode. So a bad request threw to the caller
 * with a live helper left behind, blocked on its first frame, holding a stdin
 * pipe that nothing would ever write to or close until the controller exited.
 * The caller got an exception and no `Pty`, so it had no handle to kill it with.
 *
 * `spawn` is replaced, so no process starts here in either state, and the valid
 * request is the control: without it, "spawn was not called" would also pass on
 * an `open()` that never spawned anything.
 */
const spawned = vi.hoisted(() => ({ count: 0 }));

vi.mock("node:child_process", () => ({
    spawn: () => {
        spawned.count++;
        const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = Object.assign(new EventEmitter(), {
            destroyed: false,
            writable: true,
            write: () => true,
        });
        return child;
    },
}));

const { open } = await import("../pty.js");

// Any file that exists: `open()` checks the path, and `spawn` is the fake above.
const helper = process.execPath;

describe("open() validates before it starts a helper", () => {
    beforeEach(() => {
        spawned.count = 0;
    });

    it("control: a valid request does start one", () => {
        open({ helper, argv: ["x"] });
        expect(spawned.count).toBe(1);
    });

    it("starts none for an empty argv", () => {
        expect(() => open({ helper, argv: [] })).toThrow(/non-empty/);
        expect(spawned.count).toBe(0);
    });

    it("starts none for a non-boolean windowsVerbatimArguments", () => {
        expect(() =>
            open({ helper, argv: ["x"], windowsVerbatimArguments: "true" as unknown as boolean }),
        ).toThrow(/must be a boolean/);
        expect(spawned.count).toBe(0);
    });
});
