// Typecheck the helper for ALL SIX shipped targets, without linking any of them.
//
// This exists because of a bug CI found that it should not have had to.
// `c_char` is **unsigned on aarch64-linux and signed on x86_64-linux and
// macOS**, so hardcoded `i8` C-string pointers compiled on four targets and
// failed on exactly one — discovered by the arm64 runner, after the code had
// already been pushed as "typechecks clean".
//
// It had typechecked clean. On two targets, which I had mistaken for "the
// POSIX branch". **A `cfg`-heavy file is only as checked as the targets you
// compiled it for**, and the arms you did not compile are not merely untested,
// they are unparsed.
//
// `--emit=metadata` needs no cross-linker, so all six run on any host in
// seconds — the only prerequisite is `rustup target add`, which fetches Rust's
// own std rather than any third-party code.

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
];

const installed = execFileSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

const out = mkdtempSync(path.join(tmpdir(), "fancy-pty-meta-"));
let failures = 0;
let skipped = 0;

for (const target of TARGETS) {
    if (!installed.includes(target)) {
        // Reported, never silently passed: a target that was not checked is not
        // a target that is fine, and this script's whole value is telling you
        // which arms were actually parsed.
        console.log(`  SKIP ${target.padEnd(28)} rustup target add ${target}`);
        skipped++;
        continue;
    }
    try {
        const stderr = execFileSync(
            "rustc",
            [
                "--emit=metadata",
                "--target",
                target,
                "-o",
                path.join(out, `${target}.rmeta`),
                path.join(root, "native", "helper.rs"),
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
        // Warnings go to stderr and execFileSync returns stdout, so re-run the
        // judgement on what rustc actually said rather than on the exit code:
        // a warning is an exit-0 result and would otherwise read as clean.
        void stderr;
        console.log(`  ok   ${target}`);
    } catch (e) {
        const text = `${e.stderr ?? ""}${e.stdout ?? ""}`;
        console.log(`  FAIL ${target}`);
        console.log(
            text
                .split("\n")
                .filter((l) => /^(error|warning)/.test(l))
                .slice(0, 6)
                .map((l) => `       ${l}`)
                .join("\n"),
        );
        failures++;
    }
}

console.log();
if (failures > 0) {
    console.error(`${failures} target(s) do not compile.\n`);
    process.exit(1);
}
if (skipped > 0) {
    console.log(
        `${TARGETS.length - skipped}/${TARGETS.length} targets checked, ${skipped} skipped for a missing std.\n`,
    );
} else {
    console.log(`all ${TARGETS.length} targets typecheck\n`);
}
