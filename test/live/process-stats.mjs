// Real OS process accounting: THREADS, OS HANDLES/FDs, and RSS.
//
// WHY THIS FILE EXISTS, and it is a correction rather than a feature.
//
// The leak check originally gauged `process.memoryUsage().rss` and
// `process.report.getReport().libuv.length`, and I reported that it "cleared
// the bar". It did not measure the bar:
//
//   * **Threads were not measured at all** — one of the three thresholds.
//   * **`libuv.length` is not the OS handle count.** It counts Node's
//     event-loop handles. A spawned child contributes about four of them (the
//     process plus three stdio pipes), so 20 live ptys moved it 12 -> 92 and
//     the number looked authoritative. `claude · tynn`'s Windows baseline moved
//     OS handles 287 -> 2480 over the same kind of workload. Different units,
//     different magnitudes, same word in the output.
//
// That is a PROXY MEASUREMENT: a number that tracks the real one closely enough
// to pass review and is not it. The proxy was sound for detecting "did we leak
// a pipe" and silently wrong for "does this clear a threshold someone else set
// in OS handles".
//
// So this reads the same quantities the incident was measured in. Where a
// platform cannot supply one, it returns `null` and the caller must SKIP that
// assertion out loud — never score an unavailable metric as zero, which is a
// pass handed out for a measurement that did not happen.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

/** @returns {{threads: number|null, handles: number|null, rss: number, handlesLabel: string}} */
export function processStats(pid = process.pid) {
    const rss = process.memoryUsage().rss;

    if (process.platform === "win32") {
        // One PowerShell call for both, because two would sample different
        // instants and the arithmetic downstream subtracts them.
        try {
            const out = execFileSync(
                "powershell",
                [
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    `$p = Get-Process -Id ${pid}; "$($p.Threads.Count) $($p.HandleCount)"`,
                ],
                { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
            ).trim();
            const [threads, handles] = out.split(/\s+/).map(Number);
            return {
                threads: Number.isFinite(threads) ? threads : null,
                handles: Number.isFinite(handles) ? handles : null,
                rss,
                handlesLabel: "OS handles",
            };
        } catch {
            return { threads: null, handles: null, rss, handlesLabel: "OS handles" };
        }
    }

    if (process.platform === "linux") {
        let threads = null;
        try {
            const status = readFileSync(`/proc/${pid}/status`, "utf8");
            const m = status.match(/^Threads:\s*(\d+)/m);
            threads = m ? Number(m[1]) : null;
        } catch {
            threads = null;
        }
        let handles = null;
        try {
            // Open file descriptors — the POSIX counterpart of a Windows handle
            // for this purpose, and what a leaked pty pipe would show up in.
            handles = readdirSync(`/proc/${pid}/fd`).length;
        } catch {
            handles = null;
        }
        return { threads, handles, rss, handlesLabel: "open fds" };
    }

    if (process.platform === "darwin") {
        let threads = null;
        try {
            // `ps -M` lists one line per thread after a header. `-o thcount` is
            // a Linux-ism and is silently unsupported here, which would have
            // returned an empty field rather than an error.
            const out = execFileSync("ps", ["-M", String(pid)], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            });
            const lines = out.trim().split("\n").filter(Boolean);
            threads = Math.max(0, lines.length - 1) || null;
        } catch {
            threads = null;
        }
        // Deliberately NOT guessed. `lsof` is the only general answer, it is
        // slow enough to distort a timing-sensitive loop, and it is not present
        // on every runner. Reported as unavailable so the caller skips it
        // loudly.
        return { threads, handles: null, rss, handlesLabel: "open fds (unavailable)" };
    }

    return { threads: null, handles: null, rss, handlesLabel: "unavailable" };
}
