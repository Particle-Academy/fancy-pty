# Using @particle-academy/fancy-pty — guide for agents

How an agent installs and uses this package in a consumer app. What the package
is, is in [README.md](./README.md). Notes for working ON this repo's code are in
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Install

```bash
npm install @particle-academy/fancy-pty
```

- **Node:** `>=22`. No runtime dependencies and no native addon: a prebuilt
  helper executable per `platform-arch` ships in `bin/`, so there is no
  rebuild step.
- Helpers ship for `win32`, `darwin` and `linux` on `x64` and `arm64`;
  `darwin-x64` and `win32-arm64` build but have not run natively.
- Most apps reach it through `@particle-academy/fancy-term-host`, which runs on
  it. Rendering is `@particle-academy/fancy-term`.

## Find it on the Fancy MCP server

The catalog server is `https://ui.particle.academy/mcp` (streamable HTTP, no API
key; MCP id `fancy-ui`). This package's registry entry is `fancy-pty`. As a
server-side package it is found with `search-backend-packages` (stack `node`);
`install-instructions` gives the exact install commands.

## API essentials

```ts
import { open } from "@particle-academy/fancy-pty";

const pty = open({ argv: ["cmd.exe"], cwd: "C:\\", cols: 120, rows: 30, env: process.env });
pty.onData((chunk) => process.stdout.write(chunk));
pty.onExit((code) => console.log("exited", code));
pty.onError((err) => console.error(err));
pty.write("echo hello\r\n");
pty.resize(100, 40);
pty.kill();
```

- `open({ argv, cwd, env, cols, rows, windowsVerbatimArguments? })` returns
  synchronously.
- `write`, `resize`, `kill` (with `KillOptions.graceMs` for a graceful stop);
  `onData`, `onExit`, `onError` (spawn failures, protocol faults, a helper that
  died).
- `pid` is the helper's pid; `childPid` is the command's, set by the first
  `onData`.
- `isSupported()` and `helperPath()` report the platform helper.

## Traps

- **Electron:** add
  `asarUnpack: ["**/node_modules/@particle-academy/fancy-pty/bin/**"]`. A file
  inside an asar has no real path to execute.
- **The helper runs in place, never from a temp directory.** Do not copy it
  elsewhere.
- **Windows program lookup:** a bare name searches the system directory, the
  Windows directory, then absolute `PATH` entries of the calling process. The
  current directory, the `cwd` option and `env.PATH` are not searched. Use
  `.\tool.exe` or an absolute path for a local program.
- **A `.cmd` / `.bat` needs its extension** (`npm.cmd`, not `npm`). Start it
  directly rather than through `cmd.exe /c npm`.
- **Batch-file arguments containing** `&` `|` `<` `>` `^` `%` `"` `!`, LF or CR
  **are refused** (`open()` throws), on every OS, so code behaves the same
  everywhere.
- **`windowsVerbatimArguments: true` is command injection with untrusted
  text.** Use it only for lines you wrote, wrap the whole `cmd.exe /s /c` line
  in an outer pair of quotes, and pass `argv[0]` unquoted. It is ignored on
  Linux and macOS.
- On Linux and macOS `argv[0]` goes to `execvp`, which uses `PATH` from `env`.
- It is not a terminal emulator: it moves bytes and owns process lifetime.
