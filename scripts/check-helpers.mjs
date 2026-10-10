// Prepublish gate: every supported platform MUST have its helper in the
// tarball, and each one must be a real executable for that platform.
//
// This exists because of the exact failure this package replaces. `node-pty`'s
// packaging hook reported `{ action: 'already-present', ok: true }` over a
// HOST-arch `conpty.dll` on a cross-arch build — a present-files check that ran
// before anything read the target arch — so an arm64 installer shipped green
// with a terminal that could not start. **A file being present is not the same
// as it being the right file**, and the check that only asks "is it there" is
// the one that passes on the broken build.
//
// So this reads each binary's own header and compares the machine/CPU field
// with the directory it was found in.

import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED = {
    "win32-x64": { kind: "pe", machine: 0x8664 },
    "win32-arm64": { kind: "pe", machine: 0xaa64 },
    "darwin-x64": { kind: "macho", cpu: 0x01000007 },
    "darwin-arm64": { kind: "macho", cpu: 0x0100000c },
    "linux-x64": { kind: "elf", machine: 0x3e },
    "linux-arm64": { kind: "elf", machine: 0xb7 },
};

/** PE: the machine field is 2 bytes at `e_lfanew + 4`. Verified against all four shipped node-pty binaries. */
function peMachine(buf) {
    if (buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return null; // "MZ"
    const lfanew = buf.readUInt32LE(0x3c);
    if (buf.length < lfanew + 6) return null;
    if (buf.readUInt32LE(lfanew) !== 0x0000_4550) return null; // "PE\0\0"
    return buf.readUInt16LE(lfanew + 4);
}

/** ELF: `e_machine` is 2 bytes at offset 18, little-endian for our targets. */
function elfMachine(buf) {
    if (buf.length < 20) return null;
    if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) return null;
    return buf.readUInt16LE(18);
}

/** Mach-O: `cputype` is 4 bytes at offset 4, after the magic. */
function machoCpu(buf) {
    if (buf.length < 8) return null;
    const magic = buf.readUInt32LE(0);
    if (magic === 0xfeedfacf) return buf.readUInt32LE(4); // 64-bit LE
    if (magic === 0xcffaedfe) return buf.readUInt32BE(4); // 64-bit BE-swapped
    return null;
}

let failures = 0;
const fail = (msg) => {
    console.error(`  MISSING/WRONG  ${msg}`);
    failures++;
};

for (const [key, want] of Object.entries(EXPECTED)) {
    const exe = path.join(root, "bin", key, key.startsWith("win32") ? "fancy-pty-helper.exe" : "fancy-pty-helper");
    const rel = path.relative(root, exe);
    if (!existsSync(exe)) {
        fail(`${rel} — not built`);
        continue;
    }
    const size = statSync(exe).size;
    if (size < 10_000) {
        fail(`${rel} — only ${size} bytes, that is not a linked binary`);
        continue;
    }
    const buf = readFileSync(exe);
    let got = null;
    let field = "";
    if (want.kind === "pe") {
        got = peMachine(buf);
        field = `PE machine 0x${(got ?? 0).toString(16)}`;
    } else if (want.kind === "elf") {
        got = elfMachine(buf);
        field = `ELF e_machine 0x${(got ?? 0).toString(16)}`;
    } else {
        got = machoCpu(buf);
        field = `Mach-O cputype 0x${(got ?? 0).toString(16)}`;
    }
    const expect = want.machine ?? want.cpu;
    if (got !== expect) {
        fail(`${rel} — ${field}, expected 0x${expect.toString(16)} for ${key}`);
        continue;
    }
    console.log(`  ok  ${rel}  ${size} bytes, ${field}`);
}

if (failures > 0) {
    console.error(
        `\n${failures} helper binaries missing or built for the wrong architecture. ` +
            `Publishing now would ship an installer that is green with a terminal that cannot start — ` +
            `which is the exact node-pty failure this package replaces.\n`,
    );
    process.exit(1);
}
console.log("\nall helper binaries present and correct for their architecture\n");
