import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

import { open } from "../pty.js";

/**
 * An `error` nobody listened for must reach stderr. (#1)
 *
 * WHY. A spawn failure is the most diagnosable moment this package has, and it
 * had the worst reporting. `onError` was the only channel, and
 * `fancy-term-host` forwards it into the TERMINAL data stream — right for a pty
 * that opened and then broke, useless for one that never opened, because there
 * is no terminal to render into.
 *
 * In a packaged Electron app that left `pid -1` and nothing else.
 * `claude · tynn` diagnosed the asar bug from the SHAPE of the failure — two
 * symptoms plus a correct guess about Electron's `fs` patching — rather than
 * from anything this library said. The next failure in that position (a
 * wrong-arch binary, antivirus holding the file, a permissions problem) has the
 * same shape and no reason to be as legible.
 *
 * ## The fixture is a DIRECTORY, and that is deliberate
 *
 * Node reports spawn failures two different ways, measured rather than assumed:
 *
 * | target | how it fails |
 * |---|---|
 * | a directory | **ASYNC `error` event** (ENOENT) |
 * | a non-executable file (`.ts`, `.md`) | SYNC throw (EFTYPE on Windows) |
 * | a nonexistent path | ASYNC `error` event (ENOENT) |
 *
 * Only the ASYNC path was ever silent — a synchronous throw propagates out of
 * `open()` and the caller already sees it. And a nonexistent path never reaches
 * `spawn` here, because the `existsSync` pre-flight throws first with a better
 * message.
 *
 * So a directory is the one fixture that reproduces the real shape: **the
 * existence check PASSES and the spawn then fails asynchronously** — which is
 * exactly what the asar bug did, where Electron's patched `fs` said yes and the
 * unpatched `spawn` said no. The first version of this file used a `.ts` file
 * and failed for the wrong reason, which is how the two modes got measured.
 */

const writes: string[] = [];
let spy: ReturnType<typeof vi.spyOn> | undefined;

/** A real directory: passes `existsSync`, fails `spawn` asynchronously. */
const asarShapedFixture = path.resolve(__dirname);

function captureStderr() {
    writes.length = 0;
    spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
    });
}

afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
});

/** Resolves on `exit`, which fancy-pty emits even when the spawn failed. */
function settled(pty: { onExit(fn: (code: number) => void): void }): Promise<void> {
    return new Promise((resolve) => pty.onExit(() => resolve()));
}

describe("an unheard error reaches stderr", () => {
    it("writes the engine's own words when nobody registered onError", async () => {
        captureStderr();
        const pty = open({ argv: ["irrelevant"], helper: asarShapedFixture });
        // Deliberately NO onError.
        await settled(pty);

        const text = writes.join("");
        expect(text).toContain("[fancy-pty]");
        expect(text).toContain("unhandled error");
        // The engine's actual words, not a generic placeholder — the whole
        // point is that the reason survives to somewhere a human will read it.
        expect(text).toMatch(/ENOENT|EACCES|EISDIR|spawn/i);
    });

    it("stays SILENT when a listener is present — the listener owns it", async () => {
        captureStderr();
        const seen: Error[] = [];
        const pty = open({ argv: ["irrelevant"], helper: asarShapedFixture });
        pty.onError((e) => seen.push(e));
        await settled(pty);

        expect(seen.length).toBeGreaterThan(0);
        // A library that both hands you the error AND prints it is noise, and
        // noise is how a real line gets filtered out of a log.
        expect(writes.join("")).not.toContain("[fancy-pty] unhandled error");
    });

    it("decides at EMIT time, not at open() time", async () => {
        // `open()` returns synchronously and a caller registers `onError` on
        // the NEXT line, so a check performed during `open()` would always see
        // zero listeners and print over a consumer who handles errors properly.
        // Asserted rather than trusted.
        captureStderr();
        const pty = open({ argv: ["irrelevant"], helper: asarShapedFixture });
        const seen: Error[] = [];
        pty.onError((e) => seen.push(e));
        await settled(pty);

        expect(seen.length).toBeGreaterThan(0);
        expect(writes.join("")).not.toContain("[fancy-pty] unhandled error");
    });

    it("still reports an exit, so a consumer keyed on exit never hangs", async () => {
        captureStderr();
        const pty = open({ argv: ["irrelevant"], helper: asarShapedFixture });
        pty.onError(() => {});
        let code: number | undefined;
        await new Promise<void>((resolve) =>
            pty.onExit((c) => {
                code = c;
                resolve();
            }),
        );
        // A failure that produced no EXIT would turn into a terminal that never
        // closes — an error becoming a hang, which is strictly worse.
        expect(typeof code).toBe("number");
    });
});

describe("a spawn failure names the package, on every platform", () => {
    it("wraps the raw errno so the message says what failed and where — thrown (Windows) or as the error (POSIX)", async () => {
        // A non-executable FILE throws out of spawn synchronously on Windows
        // (EFTYPE) but arrives as an `error` EVENT on POSIX (EACCES) — the CI
        // runner is Linux, and this test used to assert only the Windows half,
        // so it was red there on 0.1.3. Either way the caller used to see a bare
        // errno with no mention of fancy-pty or the path. Wrapped, because the
        // reader of that message is debugging someone else's library.
        const notExecutable = path.join(__dirname, "unheard-error.test.ts");
        let message = "";
        try {
            const pty = open({ argv: ["irrelevant"], helper: notExecutable });
            const seen: Error[] = [];
            pty.onError((e) => seen.push(e));
            await settled(pty);
            message = seen.map((e) => e.message).join("\n");
        } catch (e) {
            message = (e as Error).message;
        }
        expect(message).toContain("fancy-pty");
        expect(message).toContain(notExecutable);
    });
});
