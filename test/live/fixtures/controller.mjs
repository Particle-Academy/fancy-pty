// A stand-in for a consumer (Genie, fancy-term-host) that the lifecycle suite
// can kill outright. It opens N ptys, each running sleeper.mjs, prints the
// helper pids as one JSON line, and then idles until something kills it.
//
//   node controller.mjs <dir> <n>

import path from "node:path";
import { fileURLToPath } from "node:url";

import { open } from "../../../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const [dir, n] = process.argv.slice(2);

const ptys = [];
for (let i = 0; i < Number(n); i++) {
    const pty = open({
        argv: [process.execPath, path.join(here, "sleeper.mjs"), dir, `p${i}`],
        cols: 80,
        rows: 24,
        env: process.env,
    });
    pty.onData(() => {});
    pty.onError(() => {});
    ptys.push(pty);
}

process.stdout.write(JSON.stringify({ controller: process.pid, helpers: ptys.map((p) => p.pid) }) + "\n");
setInterval(() => {}, 1000);
