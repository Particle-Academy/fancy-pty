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

## Testing

```
npm test              # pure protocol, fast + hermetic
npm run lint          # tsc --noEmit
npm run build:helper  # rustc + the helper's --selftest
npm run verify:pty    # LIVE: real shells, resize, kill, orphan sweep, leak bar
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

## Status

Windows works end to end. **POSIX is not implemented**, and the backend returns
an error rather than a silent success — a stub reporting OK would claim a
working terminal that carries nothing, which is the failure shape this package
exists to stop shipping. Nothing has been published; the npm name does not exist
yet.
