# AGENTS.md — fancy-pty

`CLAUDE.md` is a symlink to this file.

**This file describes THIS REPO'S CODE and nothing else.** Process rules —
lifecycle, version policy, publishing procedure, backports — live in the
envelope's `RULES.md` and must never be copied here: a maintenance branch would
then carry a frozen copy of a rule that has since changed, with nothing to flag
it.

## What this package is

A pseudo-terminal for Node with **zero runtime dependencies**: a per-pty native
helper **executable** plus pure JS. It replaces `node-pty` underneath
`fancy-term-host`.

It is **not** a terminal emulator. It moves bytes and owns process lifetime;
`fancy-term` renders.

## The two invariants

Everything else in here is detail. These two are load-bearing, and both have a
test that fails if they are broken.

### 1. ONE HELPER PROCESS PER PTY

This is the reason the package exists, and it is a *property*, not a promise.
`genie#805`: a long-lived Node process holding `node-pty` reached 88,346 MB
private bytes, 78,996 handles and 7,209 threads for ~41 live terminals against
7,158 spawns — ~12 MB, ~1 thread, ~11 handles retained per **exited** pty, until
a 196 GB commit limit ran out. When a separate helper exits, the OS reclaims all
three whether or not our code is tidy.

**So: never pool helpers, never reuse one for a second pty, never move the pty
into the host process as an optimisation.** Each of those trades the one
guarantee this package offers for a performance win that nobody asked for. A
spawn costs ~56 ms, measured, which is the same order as node-pty's ~52 ms.

### 2. THE HELPER RESOLVES IN PLACE, NEVER FROM A TEMP PATH

Constraint from `claude · tynn`, who own Genie's upgrade path. The teardown kills
and *names* everything running from the install dir (`orphansUnder` plus a
by-path process lister); that is what stops a stuck child jamming an update. A
helper extracted to `os.tmpdir()` is invisible to that sweep, so one stuck
helper blocks an upgrade with nothing able to say what is holding it — the
31-orphaned-`OpenConsole.exe` failure by another route.

Temp extraction is the NORMAL way to ship a bundled binary, which is exactly why
`src/__tests__/helper-path.test.ts` asserts the resolved path is not temp-ish.
Do not "fix" it back.

## Layout

| | |
|---|---|
| `src/protocol.ts` | the frame codec + SPAWN encoding. **Pure** — no processes, no platform, no timing, which is why it is the part the unit suite can hold completely |
| `src/helper-path.ts` | where the binary lives, and invariant 2 |
| `src/pty.ts` | `open()` — spawns the helper, pumps frames |
| `native/helper.rs` | the helper. One file, `rustc` only |
| `native/proto.md` | the wire protocol |
| `scripts/build-helper.mjs` | `rustc` per target |
| `scripts/check-helpers.mjs` | `prepublishOnly` arch gate |
| `test/live/pty.live.mjs` | real shells + the leak bar |
| `test/live/lifecycle.live.mjs` | process LIFETIME: controller death, conhosts per pty, job race, graceful kill |

## The helper (`native/helper.rs`)

**No crates, and no `Cargo.toml`.** Rust std with hand-written `extern "system"`
declarations. If you find yourself wanting a crate, that is a conversation with
the owner, not a commit — the whole premise is a dependency-free PTY layer.

`-C target-feature=+crt-static` is not optional. A fresh Windows ships without
the Visual C++ redistributable, and a dynamically linked helper would fail to
start on exactly the machines a packaged app is installed on.

`--selftest` runs the pure units that need no pty: the Windows command-line
quoting rules and the SPAWN decoder. The build runs it. Those are the two pieces
a reader cannot verify by eye, and they live where vitest cannot reach.

### Two Windows traps, both already paid for

**1. Child stdio.** `STARTF_USESTDHANDLES` must be set, with all three handles
NULL. **Omitting the flag does not mean "no opinion" — it means "propagate the
parent's std handles"**, and the spawned shell then reads the HELPER's stdin
(our control channel) and writes its banner to the helper's stdout (our frame
stream). Setting the flag with NULLs is the only way to say "the child has
none", after which csrss hands it the pseudoconsole's own handles.

The misdiagnosis is worth knowing because it was confident: the symptom was read
as "a pseudoconsole cannot attach under a parent with no console of its own
(`GetConsoleWindow()` is 0), which is why node-pty ships a console-attached
agent". Wrong — that was reasoning from a third party's workaround as if it were
evidence about the API. A child that *reported* its own handle types answered it
in one run: the console had attached fine; the parent's handles were simply
propagated on top. The proof is the size — the child's screen buffer reads back
the dimensions we set, which an inherited handle cannot fake.

**2. Shutdown ordering.** EOF on the read pipe arrives only when
`ClosePseudoConsole` runs. So draining to EOF on the thread that must then
perform that close **deadlocks** — the spike hung for two minutes. The order is:
reader thread → wait for the child → `ClosePseudoConsole` → join.

### Process lifetime (0.2.0) — four rules, each with a live check

`test/live/lifecycle.live.mjs`, every check against pids the processes
REPORTED themselves (`fixtures/sleeper.mjs`), each opening with a control that
counts them alive first.

1. **The helper dies with its controller.** EOF or a broken frame on stdin
   means the controller is gone, and the helper hard-kills its tree and exits.
   The control thread therefore must never `return` for any other reason: a
   failed pty write drops the rest of the write and keeps reading. On Windows
   this was MASKED before 0.2.0, not handled: a non-detached Node controller put
   the helper in libuv's kill-on-close job. That stopped being true the moment
   the helper was spawned detached, so do not reason from the old Windows
   behaviour.
2. **No console of its own (Windows).** `src/pty.ts` spawns the helper
   `detached`, which is DETACHED_PROCESS. That leaves one conhost per pty, the
   pseudoconsole's. **The trap that comes with it:** libuv's detached flags
   include CREATE_NEW_PROCESS_GROUP, which starts the helper with Ctrl-C
   IGNORED, and children inherit that. So `win::run` calls
   `SetConsoleCtrlHandler(NULL, FALSE)` before creating the command. Without
   it the graceful kill types a Ctrl-C nobody honours. CI caught this. Review
   did not.
3. **The command is created SUSPENDED**, assigned to the job, then resumed.
   The race is microseconds wide, so the check holds it open with the helper
   env var `FANCY_PTY_TEST_ONLY_ASSIGN_DELAY_MS`, read from the HELPER's
   environment and capped at 10 s. Only a descendant **off** the console can
   escape: one still attached to the pseudoconsole dies with it anyway. That is
   why the fixture's grandchild is detached on Windows. The first red run,
   with an attached grandchild, was green on the old code.
4. **Every kill runs under `Lifetime`'s lock.** The main thread's `close()`
   moves to CLOSED before it closes the job handle or returns. No kill can act
   on a handle, or a pgid, after teardown. A graceful kill is decided on the
   WHOLE tree being empty (job active-process count; `kill(-pgid, 0)` ==
   ESRCH), not on the direct child exiting.

`check 8` in `pty.live.mjs` counts `fancy-pty-helper` by IMAGE NAME across the
machine, so on a desktop running Genie (which ships this package) it reports
Genie's helpers as survivors. Read it on a clean runner, or by path.

## Testing

```
npm test              # pure protocol, fast + hermetic
npm run lint          # tsc --noEmit
npm run build:helper  # rustc + the helper's --selftest
npm run verify:pty    # LIVE: real shells, resize, kill, orphan sweep, leak bar
npm run verify:lifecycle  # LIVE: controller death, conhosts, job race, graceful kill
npm run verify:flash  # LIVE, Windows: no console window ever APPEARS (#4)
```

**A new assertion here must be verified to FAIL against the bug it describes.**
Not a style point: the first version of the "copies the payload" test asserted
exactly the right thing and proved nothing — replacing the defensive copy with a
bare view still passed, because the scenario (`Buffer.concat` on a later chunk)
could not produce the condition. The assertion was right; the setup could not
create it. Sabotage the code, watch the test go red, then restore.

`verify:pty` opens with a **positive control** — hold 20 ptys, confirm the
gauges rise — for the same reason. The absence of that control is arguably the
root cause of `genie#805`: 7,158 spawns and 7,116 exits sat in a log for four
days while nothing compared threads to live terminals.

### `verify:flash` — no console window ever APPEARS (#4)

Windows only, and the same shape as the leak bar: the claim is a negative, so
the run is worthless unless the instrument is shown to fire first.

`fancy-term-host` #4 was a console **flash** — node-pty's legacy ConPTY path
forked an un-hidden agent whose teardown popped a console and then died with
"AttachConsole failed". The architectural answer is that this package ships no
agent process, so there is no second executable to pop a window. That is a good
argument and it is not a measurement, which is why this exists.

Two things make it real rather than reassuring:

- **The discriminator is the SHOW, not the window.** ConPTY legitimately creates
  a `PseudoConsoleWindow` for *every* pty, so counting those proves nothing —
  this was measured, not assumed. A genuinely visible console produces
  `EVENT_OBJECT_CREATE` with `vis=False` and then `EVENT_OBJECT_SHOW` with
  `vis=True`. A correctly hidden one produces the create and **never** the show.
- **`--verify` runs a positive control FIRST** and declares the run **VOID**, not
  passing, if the probe fails to see a console it opened itself. A probe that
  cannot detect a flash reports exactly what a package that never flashes does.

Measured 2026-10-11 on `win32-x64`, 8 spawn/kill cycles against 0.1.3: control
detected a visible console; subject created 8 `PseudoConsoleWindow`s and showed
**0**. Proven to go red, too — a deliberately flashing subject yields 6 visible
shows and exit 1, per the sabotage rule above.

Three traps in the probe itself, all found by the control rather than by
reading documentation:

- **An `OUTOFCONTEXT` WinEvent hook is delivered through the message queue of
  the thread that INSTALLED it.** The first draft installed on the main thread
  and pumped messages on a worker, captured zero events, and reported the
  subject clean. That is the failure mode this whole file guards against, and it
  appeared in the guard.
- **The process must be on the interactive window station**, or it sees no
  windows at all. `--sanity` counts what is already on the desktop and aborts.
- **The cycle must KILL**, because #4 was a teardown flash. A spawn-only subject
  does not exercise the half the issue was about.

One honest limit: this runs on an interactive desktop, whereas #4 appeared under
the **windowless detached service host**. The mechanism it rules out (a forked
agent popping a window) is absent by architecture in either case, but the
detached host is not what is being measured here. Say "no flash on the
interactive desktop, instrument validated" rather than rounding it up.

### Three POSIX traps (`native/posix.rs`)

**1. Nothing may allocate between `fork()` and `execvp()`.** Only
async-signal-safe calls are legal there — allocating, formatting a string or
taking a lock can deadlock against a mutex another thread held at the instant of
the fork. So every C string and pointer array the child needs is built BEFORE
the fork, and the child path is deliberately dull. This is the easiest place in
the package to write a bug that appears only under concurrency, i.e. never in a
test that opens one pty.

**2. `EIO` from reading the master is EOF, not an error.** When the last slave
fd closes, Linux fails the read with `EIO` where macOS returns 0. Treating it as
a fault makes every normal shell exit look like a crash — and a backend
developed only on macOS would ship with Linux terminals that always "error" on
close.

**3. A resize is an ioctl AND a signal.** `TIOCSWINSZ` changes what `stty size`
reports; only `SIGWINCH` makes a running program re-read it. Doing just the
ioctl is the version of this bug that looks like it works, because the obvious
test (`stty size`) passes.

`setsid()` is what allows `TIOCSCTTY`, and it also makes the child a
process-group leader — which is why `killpg(pgid, …)` takes the whole tree, the
POSIX counterpart of the job object on Windows.

The ioctl constants carry their provenance in a comment, because a wrong one is
a runtime-only failure: the Linux values were read off Ubuntu's own headers, and
the macOS values were DERIVED from the BSD `_IOW`/`_IO` encoding. A `cfg` branch
is the one kind of code a typecheck cannot vouch for — only one arm compiles on
any machine — so the macOS CI job is where that arm is proven.

## Status

**Working on four platforms, measured in CI on real runners** — 60 spawn/exit
cycles each, every one against the live suite (real shell, the execution oracle,
size reported back, resize, kill, failed spawn, orphan sweep), and each opening
with the positive control that proves the gauges move at all — 20 live ptys must
move threads or handles before any "nothing retained" result is believed.

| platform | per pty | threads | handles / fds | memory |
|---|---|---|---|---|
| `win32-x64` | 32 ms | 0.000 | 0.000 OS handles | 0.009 MB |
| `linux-x64` | 3 ms | 0.000 | 0.000 fds | 0.036 MB |
| `linux-arm64` | 2 ms | 0.000 | 0.000 fds | 0.021 MB |
| `darwin-arm64` | 12 ms | 0.000 | 0.000 fds | 0.044 MB |

The bar is all three, per exited pty: **<= 0.1 threads, <= 1.0 handles,
<= 0.5 MB**.

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

**An earlier version of this table was in the wrong units and the numbers here
replace it.** It reported `libuv` handle counts — Node's event-loop handles,
about four per spawned child — as though they were the OS handle counts the bar
is written in, and it did not measure threads at all. See
`test/live/process-stats.mjs`; that is the whole reason the file exists.

`darwin-x64` and `win32-arm64` are cross-compiled and build clean, but have not
run — nothing in CI hosts them natively. Say "builds, unproven" for those two
rather than rounding four green platforms up to six.

**Published.** `@particle-academy/fancy-pty` is on npm — `0.1.3` is `latest` as
of 2026-10-11, and CI publishes by tag over OIDC, so the owner-only bootstrap
this paragraph used to describe is done. `fancy-term-host` consumes it as an
optional dependency at `>=0.1.1 <2.0`, which means a consumer taking
`fancy-term-host` resolves whatever the newest `0.1.x` is — so a release here
reaches terminal users without them upgrading anything. Check what they actually
resolve before claiming a fix has landed for them.
