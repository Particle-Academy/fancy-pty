// A pty child for the lifecycle suite. It REPORTS rather than being guessed at:
// its own pid and its grandchild's pid land in files, so the suite can count
// survivors without having to identify processes by name or by parentage
// (which goes stale the moment a parent dies, i.e. exactly when it matters).
//
//   node sleeper.mjs <dir> <tag> [idle|graceful|stubborn]
//
//   idle      sits forever; the default signal handling applies
//   graceful  on SIGINT / SIGTERM: wait 1 s (a "job" finishing), write
//             <tag>.done, reap its grandchild, exit 0
//   stubborn  ignores SIGINT and SIGTERM; only a hard kill ends it
//
// The grandchild is spawned FIRST, before anything else, because F3 is about
// what a child does in its first instant.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const [dir, tag, mode = "idle"] = process.argv.slice(2);
const put = (name, value) => writeFileSync(path.join(dir, `${tag}.${name}`), String(value));

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
});
put("grandchild", grandchild.pid);
put("child", process.pid);

if (mode === "graceful") {
    let stopping = false;
    const stop = () => {
        if (stopping) return;
        stopping = true;
        setTimeout(() => {
            put("done", Date.now());
            grandchild.kill();
            grandchild.once("exit", () => process.exit(0));
            setTimeout(() => process.exit(0), 2000);
        }, 1000);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
} else if (mode === "stubborn") {
    process.on("SIGINT", () => {});
    process.on("SIGTERM", () => {});
}

put("ready", Date.now());
setInterval(() => {}, 1000);
