# fancy-pty helper protocol (draft, sandbox)

One helper process per PTY. The helper's **stdin** and **stdout** carry framed
messages; its **stderr** is left free for human-readable diagnostics, so a
crashing helper can still say why without corrupting the stream.

## Frame

    [type: u8][len: u32 LE][payload: len bytes]

No escaping, no delimiters, no text parsing on either side. Deliberate: the
alternative — multiplexing control onto a raw stdin stream — makes every byte of
terminal input something that might need escaping, and that is a defect class we
would be inventing for ourselves.

**No JSON anywhere.** Not for purity: `fancy-json-rs` is PLANNED, not built, so a
JSON control channel would mean hand-rolling a parser on the helper side to
carry four integers and a string list. The binary frame is smaller than the
parser would be.

## JS -> helper

| type | name | payload |
|---|---|---|
| `0x00` | `SPAWN` | see below. Must be the first frame; exactly one. |
| `0x01` | `DATA` | bytes to write to the pty |
| `0x02` | `RESIZE` | `[cols: u16 LE][rows: u16 LE]` |
| `0x03` | `KILL` | empty, or `[grace_ms: u32 LE]` (see below) |

### SPAWN payload

    [cols: u16 LE][rows: u16 LE]
    [cwd:  u32 LE len][utf8]
    [argc: u32 LE] then argc * ( [u32 LE len][utf8] )
    [envc: u32 LE] then envc * ( [u32 LE klen][utf8] [u32 LE vlen][utf8] )
    [flags: u32 LE]   optional, since 0.3.0; absent when no flag is set

**`argv` is carried as a LIST, never as a command line**, even though
`CreateProcessW` wants a single string. Windows command-line quoting is a
documented minefield (backslash runs before a quote, `cmd.exe`'s second parse),
and a consumer handing us `argv` should never have to know it. The helper owns
the join, in one place, where it can be tested.

**The one deliberate exception is flag bit 0, `windowsVerbatimArguments`.**
`cmd.exe` does not read `\"` as a quote, so a shell line cannot survive the join
above: `cmd.exe /d /s /c "C:\x\node.exe" -v` arrives as a program named
`\"C:\x\node.exe\"`. With this flag the helper (Windows only) joins `argv` with
single spaces and leaves the elements alone, as Node's option of the same name
does. It is still a list on the wire, so the helper still knows which element is
the program and can name it in an error. A raw `commandLine` string could not do
that without parsing the line for it.

**Element 0 stays a program name, not part of a line.** `lpApplicationName` is
NULL in both modes, so `CreateProcessW` parses the program from the front of the
line, and an unquoted path with a space tries the prefix first
(`C:\Program Files\x.exe` runs `C:\Program.exe` if it exists). So element 0 gets
the ordinary join, which quotes it only if it contains whitespace. A `"` in
element 0 and a NUL in any element are refused with `ERROR` then `EXIT`. Node
sends its element 0 raw because libuv resolves the program itself and passes it
as `lpApplicationName`, so the two lines match byte for byte unless the program
has whitespace.

### Extending SPAWN

There is no version field. The decoder rejects trailing bytes as version skew,
and the protocol relies on that:

- A flag is only sent when set, so a default SPAWN is byte-identical to 0.2.1 and
  still works against an older helper.
- A helper older than `flags` refuses a SPAWN that carries them, with
  `SPAWN has 4 trailing bytes -- version skew`.
- A helper that has `flags` refuses any bit it does not know, with `SPAWN carries
  unknown flags`. It must never ignore one: an ignored verbatim flag would quote
  the line and reproduce the original bug with nothing to explain it.
- `flags` must be exactly 4 bytes and last. Anything else is refused.

Each refusal is an `ERROR` frame and exit 2, before anything is created. POSIX
decodes and validates the flags the same way, then has no use for bit 0: `argv`
goes straight to `execvp`.

## helper -> JS

| type | name | payload |
|---|---|---|
| `0x81` | `DATA` | bytes read from the pty |
| `0x82` | `EXIT` | `[code: u32 LE]` |
| `0x83` | `ERROR` | utf8 message |
| `0x84` | `PID` | `[pid: u32 LE]` -- the COMMAND's pid (since 0.2.0) |
| `0x85` | `KILLED` | `[how: u8]` -- `0` graceful, `1` forced (since 0.2.0) |

`EXIT` is always the last frame, and the helper then exits. The JS side therefore
has two independent signals for the same event — the frame and the child
process's own exit — which is what lets it detect a helper that died without
reporting.

`PID` is sent once, after the command is created and before its first `DATA`.
It is absent if the command never started (an `ERROR` then `EXIT` instead).
On Windows the command is created SUSPENDED, assigned to the job, and only
then resumed, so it cannot start a process outside the tree in its first
instant; `PID` goes out between the assignment and the resume.

`KILLED` is sent at most once, immediately before `EXIT`, and only if a
`KILL` ended the pty. A pty that exited by itself sends none.

## KILL

- **Empty payload, or `grace_ms` 0**: a hard kill of the whole tree, now --
  `TerminateJobObject` on Windows, `killpg` SIGHUP then SIGKILL on POSIX.
  Exactly the 0.1.x frame and behaviour. Reports `KILLED forced`.
- **`grace_ms` > 0**: ask first -- byte `0x03` (Ctrl-C) written to the
  pseudoconsole's input on Windows, which conhost turns into `CTRL_C_EVENT`
  for every process on that console; `killpg` SIGTERM on POSIX. The helper
  then polls the TREE (the job's active-process count; `kill(-pgid, 0)` until
  ESRCH). Empty within `grace_ms` is `KILLED graceful`; still occupied at the
  deadline is a hard kill and `KILLED forced`. A second `KILL` with no grace
  during the wait forces it at once; a second graceful one is ignored.

## Controller loss

**EOF (or a broken frame) on the helper's stdin means the controller is gone**,
and the helper hard-kills the tree and exits (POSIX: SIGHUP, up to 250 ms for
the group to empty, then SIGKILL). The JS side never closes the channel on
purpose, so this only happens when the controlling process has died. There is
no "keep running without a controller" mode: nothing could ever read or end
such a pty. A consumer that wants terminals to outlive its UI keeps them in a
long-lived host process (as `fancy-term-host`'s pty host does), which remains
their controller.
