// Subject for the #4 console-flash probe (scripts/console-flash-probe.py).
//
// Runs real spawn/kill cycles so the probe has something to watch. It is driven
// BY the probe, not run directly -- on its own it proves nothing, because the
// question is about windows and this file cannot see windows.
//
// Why the cycle includes a kill: #4 was a flash on the TEARDOWN path, not the
// spawn path. node-pty's legacy ConPTY forked an un-hidden agent whose kill
// path flashed a console and then died with "AttachConsole failed". A
// spawn-only subject would not exercise the half the issue was about.
//
// Why it insists every pty produced output: a spawn that fails returns no
// window either. Without this check a silent spawn failure reads as a clean
// pass -- the same trap the leak bar's positive control exists for.

import { open } from "../../dist/index.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const CYCLES = Number(process.env.CYCLES || 8);
const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
const root = process.platform === "win32" ? "C:\\" : "/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cycle(i) {
  let dataBytes = 0;
  let exitCode = null;
  let errored = null;

  const pty = open({
    argv: [shell],
    cwd: root,
    cols: 120,
    rows: 30,
    env: process.env,
  });

  pty.onError((e) => {
    errored = e && e.message ? e.message : String(e);
  });
  pty.onData((chunk) => {
    dataBytes += chunk.length;
  });
  pty.onExit((code) => {
    exitCode = code;
  });

  // Wait for a real prompt. If this stays 0 the pty never started.
  const deadline = Date.now() + 5000;
  while (dataBytes === 0 && Date.now() < deadline) await sleep(25);

  pty.write(`echo flash-probe${process.platform === "win32" ? "\r\n" : "\n"}`);
  await sleep(250);
  pty.resize(100, 40);
  await sleep(100);

  pty.kill(); // the half #4 was about
  const killBy = Date.now() + 4000;
  while (exitCode === null && Date.now() < killBy) await sleep(25);

  console.log(
    `cycle ${i + 1}/${CYCLES}: bytes=${dataBytes} exit=${exitCode} err=${errored ?? "none"}`
  );
  return { dataBytes, exitCode, errored };
}

const version = require("../../package.json").version;
console.log("fancy-pty version:", version);
console.log("platform:", process.platform, process.arch, "node", process.version);

const results = [];
for (let i = 0; i < CYCLES; i++) {
  results.push(await cycle(i));
  await sleep(120);
}

const live = results.filter((r) => r.dataBytes > 0).length;
const exited = results.filter((r) => r.exitCode !== null).length;
const failed = results.filter((r) => r.errored).length;

console.log("---");
console.log(
  `cycles=${results.length} produced_output=${live} exited=${exited} errors=${failed}`
);
if (live !== results.length) {
  console.log("WARNING: not every pty produced output -- a silent spawn failure");
  console.log("would make this run LOOK clean while testing nothing.");
}
process.exit(live === results.length ? 0 : 3);
