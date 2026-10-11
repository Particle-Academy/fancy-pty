import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";

import {
    SUPPORTED,
    helperFileName,
    helperPath,
    isSupported,
    packageRoot,
    platformKey,
} from "../helper-path.js";
import { open } from "../pty.js";

/**
 * The placement rules, asserted — because they are a CONSTRAINT from the
 * consumer rather than an implementation choice, and the obvious "improvement"
 * breaks them silently.
 */

describe("helper placement", () => {
    it("resolves under the package, NEVER under a temp directory", () => {
        // The constraint from `claude · tynn`: Genie's upgrade teardown kills
        // and NAMES everything running from the install dir. A helper extracted
        // to a temp path is invisible to that scan, so a stuck one jams an
        // update with nothing able to say what is holding it. Temp extraction
        // is the NORMAL way to ship a bundled binary, which is exactly why this
        // needs a test rather than a comment.
        const p = helperPath();
        const tmpish = /[\\/](temp|tmp|AppData[\\/]Local[\\/]Temp|var[\\/]folders)[\\/]/i;
        expect(tmpish.test(p)).toBe(false);
        expect(path.isAbsolute(p)).toBe(true);
        expect(p.split(/[\\/]/)).toContain("bin");
    });

    it("puts each arch in its OWN directory", () => {
        // The node-pty failure being designed out: one directory holding "the"
        // dll, filled in by whichever arch happened to install, and a hook that
        // reported `already-present, ok: true` over the wrong one. Per-arch
        // directories make a wrong-arch binary unrepresentable rather than
        // merely detectable.
        const x64 = helperPath({ platform: "win32", arch: "x64" });
        const arm = helperPath({ platform: "win32", arch: "arm64" });
        expect(x64).not.toBe(arm);
        expect(x64).toContain(path.join("bin", "win32-x64"));
        expect(arm).toContain(path.join("bin", "win32-arm64"));
    });

    it("names the binary per platform", () => {
        expect(helperFileName("win32")).toBe("fancy-pty-helper.exe");
        expect(helperFileName("linux")).toBe("fancy-pty-helper");
        expect(helperFileName("darwin")).toBe("fancy-pty-helper");
    });

    it("covers both arches on all three platforms, with no gaps", () => {
        // The cross-arch hole in node-pty's packaging was an ARM64 gap nobody
        // noticed because every build host was x64. Listing the matrix here
        // means removing one is a visible edit.
        for (const platform of ["win32", "darwin", "linux"]) {
            for (const arch of ["x64", "arm64"]) {
                expect(SUPPORTED, `${platform}-${arch}`).toContain(platformKey(platform, arch));
            }
        }
        expect(SUPPORTED).toHaveLength(6);
    });

    it("reports an unsupported platform rather than guessing", () => {
        expect(isSupported("sunos", "sparc")).toBe(false);
        expect(isSupported("win32", "ia32")).toBe(false);
        expect(isSupported("linux", "x64")).toBe(true);
    });
});

describe("open() failure modes", () => {
    it("distinguishes 'installed from git' from 'swallowed by asar'", () => {
        // THREE causes need three answers, and one message covering all of
        // them sends two thirds of readers the wrong way.
        //
        // `bin/` is gitignored on purpose — six per-platform binaries would
        // make every clone carry five it cannot run — and the publish workflow
        // assembles them from native runners. So a GIT or source install has no
        // binaries at all, and the asar diagnosis would be confidently wrong
        // there: a reader would go hunting through electron-builder config for
        // a problem that is simply "this install never had them".
        //
        // Which branch fires here depends on whether the local tree has been
        // built, so both are accepted — what is asserted is that the message
        // names the RIGHT cause for the state it is in, and never the asar one
        // unless a binary for this platform really is present.
        const binRoot = path.join(packageRoot(), "bin");
        const built = existsSync(path.join(binRoot, platformKey()));

        try {
            open({ argv: ["cmd.exe"], helper: path.join(binRoot, "definitely-not-here") });
            throw new Error("open() should have thrown");
        } catch (e) {
            const msg = (e as Error).message;
            if (built) {
                expect(msg).toMatch(/asarUnpack/);
            } else {
                expect(msg).toMatch(/gitignored|no helper for/);
                expect(msg).not.toMatch(/asarUnpack/);
            }
        }
    });

    it("refuses an empty argv before spawning anything", () => {
        expect(() => open({ argv: [] })).toThrow();
    });
});
