import { describe, expect, it } from "vitest";
import path from "node:path";

import { unpackedPath } from "../helper-path.js";

/**
 * The asar rewrite, and the bug it exists for.
 *
 * FOUND ON AN INSTALLED APP AND NOT REPRODUCIBLE WITHOUT ONE, by
 * `claude · tynn`. Inside a packaged Electron app this module lives at
 * `…/resources/app.asar/node_modules/@particle-academy/fancy-pty/…`, so
 * `packageRoot()` resolves INTO the archive and the helper path named the
 * archive. The executable was genuinely on disk — `asarUnpack` had put it under
 * `app.asar.unpacked` — and the consumer's config was correct.
 *
 * **Electron patches `fs` to redirect reads of unpacked files; it does NOT
 * patch `child_process.spawn`.** So the pre-flight `existsSync` SUCCEEDED and
 * the spawn then failed on a path the OS cannot execute: a terminal came back
 * `pid -1`, no helper process ever appeared, and the error message blamed
 * `asarUnpack` — advice for a problem they did not have.
 *
 * The whole live suite, all six CI targets and 21 unit tests were green
 * throughout, because every one of them runs from an unpacked tree. Packaging
 * is a different environment, not a different configuration, and this file is
 * the cheapest available stand-in for it: the rewrite is pure string work, so
 * it can be tested without Electron, without a build and without an installer.
 */

const sep = path.sep;
const j = (...parts: string[]) => parts.join(sep);

describe("unpackedPath", () => {
    it("rewrites an app.asar segment to app.asar.unpacked", () => {
        const inside = j("C:", "Program Files", "Genie", "resources", "app.asar", "node_modules", "@particle-academy", "fancy-pty", "bin", "win32-x64", "fancy-pty-helper.exe");
        const out = unpackedPath(inside);
        expect(out).toBe(
            j("C:", "Program Files", "Genie", "resources", "app.asar.unpacked", "node_modules", "@particle-academy", "fancy-pty", "bin", "win32-x64", "fancy-pty-helper.exe"),
        );
    });

    it("leaves an already-unpacked path ALONE rather than doubling it", () => {
        // `app.asar.unpacked` contains the substring `app.asar`, so a naive
        // string replace produces `app.asar.unpacked.unpacked` and breaks a
        // path that was already correct. The match is anchored to the segment
        // END, which is what makes it idempotent.
        const already = j("resources", "app.asar.unpacked", "node_modules", "x", "bin");
        expect(unpackedPath(already)).toBe(already);
        expect(unpackedPath(unpackedPath(already))).toBe(already);
    });

    it("is idempotent on a path it DID rewrite", () => {
        const inside = j("resources", "app.asar", "node_modules", "x");
        const once = unpackedPath(inside);
        expect(unpackedPath(once)).toBe(once);
    });

    it("touches nothing in an ordinary path", () => {
        const normal = j("C:", "work", "repo", "node_modules", "@particle-academy", "fancy-pty", "bin", "win32-x64", "fancy-pty-helper.exe");
        expect(unpackedPath(normal)).toBe(normal);
    });

    it("rewrites an archive that is NOT called app.asar", () => {
        // Electron allows arbitrarily named archives and `asarUnpack` always
        // produces `<name>.asar.unpacked`, so the rule is "any segment ending
        // .asar" rather than the literal `app.asar`. Hardcoding the common name
        // would work for Genie and fail for someone else, which is the worst
        // kind of fix: correct for the reporter only.
        const other = j("resources", "worker.asar", "node_modules", "x", "bin");
        expect(unpackedPath(other)).toBe(j("resources", "worker.asar.unpacked", "node_modules", "x", "bin"));
    });

    it("does not rewrite a segment that merely CONTAINS .asar", () => {
        // `my.asar.backup` is a directory, not an archive. Anchoring to the
        // segment end is what keeps this from mangling it.
        const notAnArchive = j("resources", "my.asar.backup", "node_modules", "x");
        expect(unpackedPath(notAnArchive)).toBe(notAnArchive);
    });

    it("rewrites EVERY archive segment, not just the first", () => {
        const nested = j("a.asar", "b", "c.asar", "d");
        expect(unpackedPath(nested)).toBe(j("a.asar.unpacked", "b", "c.asar.unpacked", "d"));
    });

    it("is case-insensitive on the extension, as Windows paths are", () => {
        const upper = j("resources", "App.ASAR", "node_modules", "x");
        expect(unpackedPath(upper)).toBe(j("resources", "App.ASAR.unpacked", "node_modules", "x"));
    });
});
