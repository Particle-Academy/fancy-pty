// Build the helper executable for one target, with rustc and nothing else.
//
// No Cargo.toml, no crates, no build script of its own. The helper uses Rust
// std with hand-written `extern "system"` declarations, so `rustc` on its own is
// the entire toolchain — which is also what keeps the third-party surface of
// this package at zero in both directions.
//
//   node scripts/build-helper.mjs                  host platform/arch
//   node scripts/build-helper.mjs --target aarch64-pc-windows-msvc
//
// Usage note: cross-compiling needs `rustup target add <triple>` first. Rust
// ships its own std for each target, so that is a toolchain download and not a
// third-party dependency of this package.

import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Node's platform/arch names on the left, Rust target triples on the right.
 *
 * Written out rather than derived, because the two naming schemes agree often
 * enough to make a derivation look right and then be wrong in one cell — and
 * the cell it is wrong in is whichever one this machine cannot test.
 */
const TARGETS = {
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
};

function parseArgs(argv) {
    const i = argv.indexOf("--target");
    if (i === -1) return { key: `${process.platform}-${process.arch}` };
    const want = argv[i + 1];
    const key = Object.entries(TARGETS).find(([k, triple]) => k === want || triple === want)?.[0];
    if (!key) {
        console.error(
            `unknown target '${want}'. Known: ${Object.keys(TARGETS).join(", ")}`,
        );
        process.exit(2);
    }
    return { key };
}

const { key } = parseArgs(process.argv.slice(2));
const triple = TARGETS[key];
if (!triple) {
    console.error(`fancy-pty does not ship a helper for ${key}`);
    process.exit(2);
}

const outDir = path.join(root, "bin", key);
mkdirSync(outDir, { recursive: true });
const exe = path.join(outDir, key.startsWith("win32") ? "fancy-pty-helper.exe" : "fancy-pty-helper");

const args = [
    "-O",
    // Statically link the CRT so the binary runs on a bare machine with no
    // Visual C++ redistributable installed. Not a nicety: a fresh Windows 11
    // ships without it, and every `.node` addon then fails to load reporting
    // `Cannot find native binding` — which reads like a missing FILE rather
    // than a missing RUNTIME, and cost `claude · tynn` a clean-VM
    // investigation. A static binary cannot have that failure.
    "-C",
    "target-feature=+crt-static",
    // Strip the symbol table. MEASURED, from the published 0.1.0 tarball:
    // unstripped, the Linux helpers were **5.60 MB and 5.48 MB** against
    // Windows' 0.30 MB — 18x, because ELF and Mach-O carry debug symbols INSIDE
    // the binary where Windows puts them in a separate `.pdb` (which is already
    // excluded from the tarball). That made the package 13.64 MB unpacked, in
    // every consumer's node_modules, for a PTY layer.
    //
    // The trade, stated rather than assumed: a crash backtrace loses function
    // names. Panic messages keep their file and line regardless — those are
    // compiled in as static strings — and this is ~700 lines of straight-line
    // syscalls with no recursion, so a named backtrace was never going to be
    // the thing that diagnosed it. Consistent with dropping the pdb.
    "-C",
    "strip=symbols",
    "--target",
    triple,
    path.join(root, "native", "helper.rs"),
    "-o",
    exe,
];

console.log(`[fancy-pty] rustc --target ${triple}`);
try {
    execFileSync("rustc", args, { stdio: "inherit", cwd: root });
} catch (e) {
    console.error(
        `\n[fancy-pty] rustc failed. For a cross build, run:\n` +
            `    rustup target add ${triple}\n`,
    );
    process.exit(1);
}

if (!existsSync(exe)) {
    console.error(`[fancy-pty] rustc reported success but ${exe} is missing`);
    process.exit(1);
}
console.log(`[fancy-pty] ${path.relative(root, exe)}  ${statSync(exe).size} bytes`);

// Only the host build can run its own selftest — the pure units (Windows
// command-line quoting, SPAWN decoding) that need no pty, console or consumer.
// A cross build is skipped rather than pretended: running it under emulation
// would report on the emulator.
if (key === `${process.platform}-${process.arch}`) {
    execFileSync(exe, ["--selftest"], { stdio: "inherit" });
}
