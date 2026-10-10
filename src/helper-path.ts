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
    return path.join(dir, helperFileName(platform));
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
