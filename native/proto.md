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
| `0x03` | `KILL` | empty |

### SPAWN payload

    [cols: u16 LE][rows: u16 LE]
    [cwd:  u32 LE len][utf8]
    [argc: u32 LE] then argc * ( [u32 LE len][utf8] )
    [envc: u32 LE] then envc * ( [u32 LE klen][utf8] [u32 LE vlen][utf8] )

**`argv` is carried as a LIST, never as a command line**, even though
`CreateProcessW` wants a single string. Windows command-line quoting is a
documented minefield (backslash runs before a quote, `cmd.exe`'s second parse),
and a consumer handing us `argv` should never have to know it. The helper owns
the join, in one place, where it can be tested.

## helper -> JS

| type | name | payload |
|---|---|---|
| `0x81` | `DATA` | bytes read from the pty |
| `0x82` | `EXIT` | `[code: u32 LE]` |
| `0x83` | `ERROR` | utf8 message |

`EXIT` is always the last frame, and the helper then exits. The JS side therefore
has two independent signals for the same event — the frame and the child
process's own exit — which is what lets it detect a helper that died without
reporting.
