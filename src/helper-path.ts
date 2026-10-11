import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the per-pty helper executable lives, and why it may never move.
 *
 * **HARD CONSTRAINT: the helper must resolve IN PLACE under the install
 * directory, and must NEVER be extracted to a temp path on first use.**
 *
 * Temp extraction is the normal way a package ships a bundled binary, and it is
 * what this file would otherwise have done. The constraint comes from
 * `claude · tynn`, who own Genie's upgrade path: the teardown kills and *names*
 * everything running from the install dir (an `orphansUnder` sweep plus a
 * by-path process lister), and that is what stops a stuck child jamming an
 * update. A helper living in `os.tmpdir()` is invisible to that scan, so one
 * stuck helper would block an upgrade with nothing able to say what was holding
 * it — the same failure as the 31 orphaned `OpenConsole.exe` processes, reached
 * by another route, and it would have shipped looking perfectly correct.
 *
 * So there is no extraction step, no cache directory, and no download. The
 * binary sits inside the package, which in a packaged Electron app means
 * `resources/app.asar.unpacked/node_modules/@particle-academy/fancy-pty/bin/…`.
 *
 * That is also why `bin/` must be `asarUnpack`ed: a file inside an asar archive
 * has no real path for the OS to execute — and none for a teardown sweep to
 * recognise either.
 */

/** `win32-x64`, `darwin-arm64`, `linux-x64`, … */
export function platformKey(
    platform: string = process.platform,
    arch: string = process.arch,
): string {
    return `${platform}-${arch}`;
}

export function helperFileName(platform: string = process.platform): string {
    return platform === "win32" ? "fancy-pty-helper.exe" : "fancy-pty-helper";
}

/**
 * This module's own directory, in BOTH halves of the dual build.
 *
 * `__dirname` does not exist in the ESM output and `import.meta.url` does not
 * exist in the CJS one, so either alone breaks a real consumer — and the half
 * it breaks is whichever half nobody tested. This is the same expression
 * `fancy-term-host` ships in `src/host-script.ts`; the bundler rewrites
 * whichever side does not apply.
 */
function moduleDir(): string {
    return typeof __dirname !== "undefined"
        ? __dirname
        : path.dirname(fileURLToPath(import.meta.url));
}

/**
 * The package root — one level up from `dist/`, where `bin/` sits beside
 * `package.json`.
 */
export function packageRoot(): string {
    return path.resolve(moduleDir(), "..");
}

/**
 * Rewrite a path inside an Electron asar archive to its unpacked twin.
 *
 * THE BUG THIS FIXES, found by `claude · tynn` on an INSTALLED app and not
 * reproducible from an unpacked tree: inside Electron this module lives at
 * `…/resources/app.asar/node_modules/@particle-academy/fancy-pty/…`, so
 * `packageRoot()` resolves into the archive and the helper path points inside
 * it. The executable is genuinely on disk — `asarUnpack` put it at
 * `…/resources/app.asar.unpacked/node_modules/…/bin/<platform>-<arch>/` — but
 * the path we built names the archive.
 *
 * **Electron patches `fs` to redirect reads of unpacked files; it does NOT
 * patch `child_process.spawn`.** So the pre-flight `existsSync` SUCCEEDS
 * through the patched `fs` and the spawn then fails on a path the OS cannot
 * execute. A terminal returns `pid -1`, no helper process ever appears, and the
 * consumer's config was correct the whole time — which is why the error message
 * telling them to add `asarUnpack` was advice for a problem they did not have.
 *
 * `node-pty` never hit this because its whole package is unpacked and its
 * `.node` loads through `process.dlopen`, which Electron *does* patch.
 *
 * Any segment ending `.asar` is rewritten, not just `app.asar`: Electron allows
 * arbitrarily named archives, and `asarUnpack` always produces
 * `<name>.asar.unpacked`. A path already containing `.asar.unpacked` is left
 * alone — the match is anchored to the segment end, so it cannot double-apply.
 */
export function unpackedPath(p: string): string {
    const sep = path.sep;
    return p
        .split(sep)
        .map((segment) => (/\.asar$/i.test(segment) ? `${segment}.unpacked` : segment))
        .join(sep);
}

/**
 * Absolute path to the helper for a platform/arch.
 *
 * @param options.dir escape hatch for a consumer whose packager puts `bin/`
 *   somewhere unpredictable. It carries the same responsibility: the directory
 *   must be a real one under the install tree, never a temp copy.
 */
export function helperPath(
    options: { platform?: string; arch?: string; dir?: string } = {},
): string {
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    const dir = options.dir ?? path.join(packageRoot(), "bin", platformKey(platform, arch));
    // The asar rewrite applies to the DEFAULT path only. An explicit `dir` is
    // the consumer's own claim about where the binary is, and silently
    // rewriting it would make their override mean something they did not say.
    const resolved = options.dir ? path.join(dir, helperFileName(platform)) : unpackedPath(path.join(dir, helperFileName(platform)));
    return resolved;
}

/** Platform/arch pairs this package ships a helper for. */
export const SUPPORTED: readonly string[] = [
    "win32-x64",
    "win32-arm64",
    "darwin-x64",
    "darwin-arm64",
    "linux-x64",
    "linux-arm64",
] as const;

export function isSupported(
    platform: string = process.platform,
    arch: string = process.arch,
): boolean {
    return SUPPORTED.includes(platformKey(platform, arch));
}
