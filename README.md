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

## Which program a name starts on Windows

A name with no directory part, like `cmd.exe` above, is looked up in this order,
with `.exe` appended if it has no extension:

1. the system directory
2. the Windows directory
3. the absolute entries of `PATH`, as seen by the process that called `open()`

**The current directory, the directory the helper lives in, relative or empty
`PATH` entries and the `cwd` option are not searched.** So a bare `cmd.exe` means
the system's, whatever folder your app happens to be running in.

- **A program in the current directory has to be asked for:** `.\tool.exe`, or an
  absolute path. A name with a directory part is relative to the process that
  called `open()`, not to the `cwd` option, and is not searched.
- **A `.cmd` or `.bat` needs its extension:** `npm.cmd`, not `npm`. It is resolved
  the same way, and the script sees its full path as `%0`.
- **`env.PATH` does not affect this.** It is what the child gets, not where the
  program is looked for.
- **A shell does its own lookup once it is running.** `cmd.exe` looks in its
  current directory first, so `cmd.exe /c npm` is not covered by the above. Start
  `npm.cmd` directly.

On Linux and macOS, `argv[0]` goes to `execvp`, which uses `PATH` from `env`.

## Arguments to a `.cmd` or `.bat` are refused if `cmd.exe` would act on them

Windows runs every `.cmd` and `.bat` as `cmd.exe /c <line>`, whatever you asked for,
and `cmd.exe` parses that line itself. No quoting of ours can make that safe: an
`&` in an argument runs a second command.

So by default `open()` throws, and starts nothing, if the program is a batch file
and any argument contains one of:

`&` `|` `<` `>` `^` `%` `"` `!`, a line feed, or a carriage return

The error names the argument's position and shows only its first 12 characters.

```ts
open({ argv: ["npm.cmd", "install", "--save-dev", "a b"] }); // fine
open({ argv: ["npm.cmd", "run", userText] }); // throws if userText contains any of those
```

- **What to do.** Plain arguments need nothing: flags, `key=value`, and paths with
  spaces all work. If you do need one of these characters, set
  `windowsVerbatimArguments: true` and quote it yourself (see below). Do not do that
  with text you did not write.
- **This is the same on every OS, on purpose.** On Linux and macOS a `.cmd` is not a
  batch file: `argv` goes straight to `execvp` with no shell and the arguments arrive
  literally, so there is no risk there. It is refused anyway so that code behaves the
  same everywhere, and a developer on a Mac finds this before a Windows user does.
  `windowsVerbatimArguments: true` lifts it on those platforms too, and changes
  nothing else there.
- **"A batch file" is judged by name, however it is spelled.** Case does not matter,
  and neither do the trailing dots and spaces Windows strips. On Windows the helper
  checks again on the path it resolved, and reports the same message through
  `onError`.
- **Any other program is unaffected.** An `.exe` gets its arguments literally and
  nothing parses them for it. That includes `cmd.exe /c <text>`, where you chose the
  shell: see the warning below.

## Running a shell line on Windows

`argv` is a list, and by default the helper quotes it into a command line by the
rules ordinary Windows programs parse. `cmd.exe` is not one of them. It does not
read `\"` as a quote, so a quoted path in a line passed to `cmd.exe /c` fails
with `'\"C:\...\node.exe\"' is not recognized`.

`windowsVerbatimArguments: true` is Node's `child_process` option of the same
name. It joins `argv` with single spaces and changes nothing else:

```ts
// The line carries an outer pair of quotes, exactly as Node's `shell: true` does.
const line = `"C:\\Program Files\\nodejs\\node.exe" --version`;
open({ argv: ["cmd.exe", "/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true, env: process.env });
```

> **Warning: never pass untrusted text through this option. It is command
> injection.** All quoting becomes your job, and in a line given to `cmd.exe`,
> `&`, `|`, `<`, `>`, `^` and `%VAR%` are live. A filename, a branch name or any
> other value you did not write can run commands of its own. Quoting does not
> make it safe: the value can contain a `"` that closes your quotes. If you have
> a program and a list of arguments, use the default mode, which needs no quoting
> from you and starts no shell. The exception is a `.cmd` or `.bat`: Windows always
> runs one through `cmd.exe`, in either mode. The default mode refuses the arguments
> `cmd.exe` would act on; this option turns that off, so pass it only values you wrote.

- **Outer quotes matter, and leaving them off can run the wrong program.** `/s`
  makes `cmd.exe` remove the first and the last `"` on the line, so
  `"C:\a b\x.exe" --flag` becomes `C:\a b\x.exe --flag`, and `cmd.exe` then looks
  for a program called `C:\a`. If `C:\a.exe` exists, that is what runs. Wrap the
  whole line in one more pair, as above, every time.
- **`argv[0]` is still the program, not part of the line.** Pass it unquoted. It
  is quoted for you if it has whitespace, so `C:\Program Files\x.exe` cannot run
  `C:\Program.exe`. A `"` in it is refused with an error. This is the one
  difference from Node, which sends it raw and resolves the program separately;
  without whitespace the two command lines are byte-identical.
- **Program lookup and errors are the same as a default spawn.** A program that
  cannot be found is an `onError` naming it.
- **On Linux and macOS the option is ignored**, as in Node: `argv` goes straight
  to `execvp` and there is no command line. A non-boolean value throws on every
  platform.
- **Default off.** A spawn without it is byte-for-byte what it always was.

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
