# @particle-academy/fancy-pty

A pseudo-terminal for Node with **no runtime dependencies and no native
addon** — a tiny native helper *executable* plus pure JavaScript.

```ts
import { open } from "@particle-academy/fancy-pty";

const pty = open({ argv: ["cmd.exe"], cwd: "C:\\", cols: 120, rows: 30, env: process.env });

pty.onData((chunk) => process.stdout.write(chunk));
pty.onExit((code) => console.log("exited", code));

pty.write("echo hello\r\n");
pty.resize(100, 40);
pty.kill();
```

Four verbs, two subscriptions, and one more for faults the previous engine had
no way to report:

| | |
|---|---|
| `open({ argv, cwd, env, cols, rows })` | start a pty; returns synchronously |
| `write(data)` · `resize(cols, rows)` · `kill()` | drive it |
| `onData(cb)` · `onExit(cb)` | its output and its end |
| `onError(cb)` | spawn failures, protocol faults, a helper that died |

## Why this exists

**It replaces `node-pty`, and it was not a preference.**

On 2026-10-06 a workstation ran out of commit memory — 194.6 GB of a 196.2 GB
limit — and a supervised process died with *"The paging file is too small for
this operation to complete"*. The holder was a long-lived Node process owning
PTYs through `node-pty` 1.1.0: **88,346 MB private bytes, 78,996 handles and
7,209 threads for ~41 live terminals**, against 7,158 spawns and 7,116 exits in
its log. That is about **12 MB of commit, 1 thread and 11 handles retained per
EXITED pty**. The machine had to be rebooted.

Two things follow, and the second is the design:

1. The leak was in third-party native code, reached through a package *we*
   publish. Every consumer inherited it and we carried the blame with none of
   the remedy.
2. **A per-pty child process cannot leak into the host.** That is a property of
   the shape, not a promise about the implementation: when a separate helper
   exits, the OS reclaims its commit, threads and handles whether or not our
   code is tidy. No amount of care inside a long-lived process offers the same
   guarantee.

## What a helper executable buys over a native addon

A `.node` addon is coupled to the runtime's ABI, and that coupling is the source
of an entire family of packaging failures. A plain executable has none of it, so
those failures become **unexpressible rather than fixed**:

| the usual failure | why it cannot happen here |
|---|---|
| `electron-builder` never packs a `peerDependency`, so an installer ships with no addon and reports green | nothing to collect; the binary is a file in `bin/` |
| the default `@electron/rebuild` pass needs Python + MSVC and dies on a clean Windows | there is no rebuild. No node-gyp, no `node-addon-api`, no `npmRebuild` question |
| a prebuild resolved for the wrong arch loads and fails at runtime | one directory per `platform-arch`; a wrong-arch binary is not representable |
| a packaging hook reports `already-present, ok: true` over a host-arch DLL on a cross-arch build | `prepublishOnly` reads each binary's own PE/ELF/Mach-O header and compares it with the directory it sits in |
| a fresh Windows has no Visual C++ redistributable, so every addon fails with `Cannot find native binding` | the helper is statically linked (`-C target-feature=+crt-static`) |

On Windows there is also **no redistributable of any kind** — no `conpty.dll`, no
`OpenConsole.exe`. The pseudoconsole API is in-box `kernel32`, and there is no
console-attached agent process, so there is no second executable to orphan.

## Packaging it into an Electron app

One line, and it is the only one:

```js
// electron-builder config
asarUnpack: ["**/node_modules/@particle-academy/fancy-pty/bin/**"],
```

A file inside an asar archive has no real path for the OS to execute. That is
the whole requirement — no `afterPack` hook, no signing step, no rebuild.

**The helper resolves in place and is never extracted to a temp directory.** That
is a hard constraint rather than an implementation detail: Genie's upgrade
teardown kills and *names* everything running from the install directory, which
is what stops a stuck child jamming an update. A helper living in `os.tmpdir()`
is invisible to that sweep, so one stuck helper would block an upgrade with
nothing able to say what was holding it.

## Platforms

Helpers ship for `win32`, `darwin` and `linux` on both `x64` and `arm64`.
Windows uses ConPTY; macOS and Linux use `posix_openpt` with
`fork`/`setsid`/`TIOCSCTTY`.

Measured in CI on real runners, 60 spawn/exit cycles per platform:

| platform | per pty | threads | handles / fds | memory |
|---|---|---|---|---|
| `win32-x64` | 32 ms | 0.000 | 0.000 OS handles | 0.009 MB |
| `linux-x64` | 3 ms | 0.000 | 0.000 fds | 0.036 MB |
| `linux-arm64` | 2 ms | 0.000 | 0.000 fds | 0.021 MB |
| `darwin-arm64` | 12 ms | 0.000 | 0.000 fds | 0.044 MB |

Against a bar of **<= 0.1 threads, <= 1.0 handles and <= 0.5 MB** per exited
pty. `darwin-x64` and `win32-arm64` cross-compile clean but have not run
natively anywhere.

### The same-VM comparison, which is the only rigorous one

Measured by `claude · tynn` in `genie-test-windows`, **both engines in the same
VM on the same workload** — 120 open/exit cycles, and 20 held open as a positive
control. Earlier figures in this file were from different machines and are not
comparable; these are.

| per exited pty | `node-pty` 1.x | `fancy-pty` 0.1.1 |
|---|---|---|
| threads | 1.07 | **0.000** |
| handles | 18.3 | **0.00** |
| memory | 13.3 MB | **0.011 MB** |
| 20 live ptys | **+40 threads** | **+0 threads** |

Threads and handles are not reduced, they are **eliminated** — zero, not a
smaller number. Memory is over a thousandfold lower, and `0.011 MB` is near the
floor of what the gauge resolves rather than a measured plateau, so read it as
"nothing detectable" rather than as a precise figure.

**The `+0 threads` row is the architecture showing up in an instrument.**
node-pty puts roughly two threads per live pty *inside the host process* and
keeps one of them after the pty exits. fancy-pty's threads live in the per-pty
helper, so the host gains none and an exited terminal cannot leave one behind.
That is a property of the shape, not a promise about the code.

Also green in that VM on this engine: `verify:terminal` 8/8, 650 unit tests, the
window smoke 1–40 on an installed build including typing into a real terminal,
and the live "agents hold no pty" scan 12/12 — a terminal is exactly one
headless conhost (0 → 1 → 0) and a running agent adds none. Linux (WSL2) ran the
same set green.

Note `threads` in particular: the host process gains **no thread per pty**,
because the threads live in the helper processes. `node-pty` creates about two
per live pty inside the host and retains one of them per exited pty.

This is **not** a terminal emulator. It moves bytes and owns process lifetime;
rendering belongs to [`fancy-term`](https://github.com/Particle-Academy/fancy-term).

## Tests

```
npm test             # the pure protocol — fast, hermetic
npm run build:helper # rustc, then the helper's own --selftest
npm run verify:pty   # LIVE: real shells, resize, kill, and the leak bar
```

`verify:pty` asserts the numbers the incident set, per exited pty: **≤ 0.1
threads, ≤ 1.0 handles, ≤ 0.5 MB** — thresholds chosen so the 2026-10-06 figures
fail by 10× and a tidy engine passes with headroom. It opens with a *positive
control* (hold 20 ptys, confirm the gauges rise), because a leak check that has
never seen its gauges move cannot go red.

## Building the helper

`rustc` and nothing else. No `Cargo.toml`, no crates — Rust std with
hand-written `extern "system"` declarations.

```
npm run build:helper                                   # host
node scripts/build-helper.mjs --target win32-arm64     # cross (needs rustup target add)
```

## Licence

MIT
