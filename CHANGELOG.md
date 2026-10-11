# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

**This package is pre-1.0, so breaking changes land in MINOR releases.** The
version number is not a stability promise until 1.0; read the entry.

## [Unreleased]

### Added

- **The Windows backend, end to end.** ConPTY through the in-box `kernel32`
  pseudoconsole API: spawn with `argv`/`cwd`/`env`, read, write, resize, kill
  via a job object, and exit reporting. No `conpty.dll`, no `OpenConsole.exe`,
  no redistributable of any kind.
- **The per-pty helper executable**, built by `rustc` alone — no `Cargo.toml`,
  no crates, Rust std with hand-written `extern "system"` declarations. Linked
  with `-C target-feature=+crt-static` so it runs on a bare Windows with no
  Visual C++ redistributable installed; a missing redistributable makes every
  `.node` addon fail as `Cannot find native binding`, which reads like a missing
  file rather than a missing runtime.
- **The framed stdin/stdout protocol** (`native/proto.md`) and its JS codec,
  with `stderr` left free for diagnostics so a crashing helper can still say why
  without corrupting the stream.
- `npm run verify:pty` — the live suite: real shells, the execution oracle,
  resize, kill, a failed spawn, an orphan sweep, and the leak bar. It opens with
  a **positive control** (hold 20 ptys, confirm the gauges rise), because a leak
  check that has never seen its gauges move cannot go red.
- `prepublishOnly` reads every shipped binary's own PE / ELF / Mach-O header and
  compares the machine field with the directory it sits in. A present-files
  check is what let a host-arch `conpty.dll` ship green on a cross-arch build.

### Notes

- **The helper resolves IN PLACE under the install directory and is never
  extracted to a temp path.** A hard constraint, not an implementation detail:
  Genie's upgrade teardown kills and *names* everything running from the install
  dir, so a helper in `os.tmpdir()` would be invisible to that sweep and one
  stuck helper could jam an upgrade with nothing able to name it.
- **ESM with an `exports.import` condition.** Measured rather than chosen: a
  built ESM Electron main bundle leaves packages external, and Node refuses a
  named import from a CJS package with getter-defined exports. CJS is carried
  too, for everyone else.
- **The POSIX backend** — `posix_openpt` / `grantpt` / `unlockpt` / `ptsname`,
  then `fork` + `setsid` + `ioctl(TIOCSCTTY)` + `dup2` + `execvp`, with a
  CLOEXEC errno pipe so a failed exec is reported rather than appearing as a
  shell that exited 127. Verified by the live suite on real CI runners:

  | platform | per pty | threads | handles / fds | memory |
  |---|---|---|---|---|
  | `win32-x64` | 32 ms | 0.000 | 0.000 OS handles | 0.009 MB |
  | `linux-x64` | 3 ms | 0.000 | 0.000 fds | 0.036 MB |
  | `linux-arm64` | 2 ms | 0.000 | 0.000 fds | 0.021 MB |
  | `darwin-arm64` | 12 ms | 0.000 | 0.000 fds | 0.044 MB |

  `darwin-x64` and `win32-arm64` cross-compile clean but have not run — nothing
  in CI hosts them natively, and "builds" is not "works".
- **The leak check measures the bar's own units** — threads, OS handles/fds and
  RSS (`test/live/process-stats.mjs`). An earlier version gauged `libuv` handle
  counts, which are Node's event-loop handles rather than OS handles, and did
  not measure threads at all; it reported a pass against a threshold it was not
  measuring. An unavailable metric is now skipped out loud rather than scored
  as zero.
- `npm run lint` typechecks the helper for **all six** targets, not just the
  host. `c_char` is unsigned on `aarch64-linux` and signed elsewhere, so
  hardcoded `i8` C-string pointers compiled on four targets and failed on one;
  a `cfg`-heavy file is only as checked as the targets you compiled it for, and
  the arms you did not compile are unparsed rather than merely untested.

<!--
Nothing has been released yet. The first publish needs the npm name to exist,
which is a one-time authenticated step only the owner can perform; see
.ai/knowledge/publishing.md in the envelope.
-->
