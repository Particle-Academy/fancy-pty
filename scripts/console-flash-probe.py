"""
Does a fancy-pty spawn/kill cycle ever make a console window APPEAR?  (#4)

Windows only. The answer this package needs is "no", and the hard part is not
getting that answer -- it is earning the right to believe it. A console flash
lasts tens of milliseconds, so polling the foreground window misses it by
construction, and a probe that cannot see a flash reports exactly the same
thing as a package that never flashes.

So the instrument is validated on every run. `--verify` does both halves and
only exits 0 if BOTH hold:

  1. POSITIVE CONTROL -- a deliberately visible console (cmd.exe with
     CREATE_NEW_CONSOLE) must be DETECTED. If it is not, the probe is blind
     and the run is void rather than passing.
  2. SUBJECT -- the fancy-pty cycles must produce no visible console window.

The discriminator, measured rather than assumed: ConPTY legitimately creates a
`PseudoConsoleWindow` for every pty, so the mere existence of one proves
nothing. A genuinely visible console produces CREATE (vis=False) followed by
EVENT_OBJECT_SHOW with vis=True. A correctly hidden one produces the CREATE and
never the SHOW. The verdict keys on the SHOW, not on the window.

Two traps, both found by the control rather than by reading documentation:

  * An OUTOFCONTEXT WinEvent hook is delivered through the message queue of the
    THREAD THAT INSTALLED IT. The first draft installed on the main thread and
    pumped on a worker, captured zero events, and reported the subject clean.
    The hook and the pump must be the same thread -- hence the subject runs on
    the worker and the main thread does nothing but pump.
  * The process must be on the interactive window station. `--sanity` counts
    the top-level windows already on the desktop; near zero means blind.

Usage:
  python -I scripts/console-flash-probe.py --sanity
  python -I scripts/console-flash-probe.py --verify        # the real check
  python -I scripts/console-flash-probe.py --control
  python -I scripts/console-flash-probe.py --node test/live/flash-cycles.mjs
"""

import argparse
import ctypes
import ctypes.wintypes as w
import json
import os
import subprocess
import sys
import threading
import time

if sys.platform != "win32":
    print("SKIP: Windows-only probe (console windows are a Windows concept).")
    sys.exit(0)

user32 = ctypes.WinDLL("user32", use_last_error=True)

EVENT_OBJECT_CREATE = 0x8000
EVENT_OBJECT_SHOW = 0x8002
WINEVENT_OUTOFCONTEXT = 0x0000
OBJID_WINDOW = 0
CREATE_NEW_CONSOLE = 0x00000010

CONSOLE_CLASSES = (
    "ConsoleWindowClass",
    "PseudoConsoleWindow",
    "CASCADIA_HOSTING_WINDOW_CLASS",
)

WinEventProcType = ctypes.WINFUNCTYPE(
    None, w.HANDLE, w.DWORD, w.HWND, w.LONG, w.LONG, w.DWORD, w.DWORD,
)


def class_of(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def title_of(hwnd):
    buf = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, buf, 512)
    return buf.value


def pid_of(hwnd):
    pid = w.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def sanity():
    found = []
    EnumWindowsProc = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)

    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            found.append(class_of(hwnd))
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    print("visible top-level windows on this desktop:", len(found))
    ok = len(found) >= 3
    print("DESKTOP VISIBLE TO THIS PROCESS :", ok)
    if not ok:
        print("  -> probe is BLIND here; no verdict from it is valid.")
    return ok


class Run:
    """One observed window: install hook, run subject, collect events."""

    def __init__(self, label):
        self.label = label
        self.events = []
        self.lock = threading.Lock()
        self.result = {}

    def _handler(self, hook, event, hwnd, id_object, id_child, thread, ms):
        if id_object != OBJID_WINDOW or not hwnd:
            return
        try:
            rec = {
                "t": time.time(),
                "event": "SHOW" if event == EVENT_OBJECT_SHOW else "CREATE",
                "cls": class_of(hwnd),
                "title": title_of(hwnd),
                "pid": pid_of(hwnd),
                "visible": bool(user32.IsWindowVisible(hwnd)),
            }
        except Exception as exc:
            rec = {"t": time.time(), "event": "ERR", "err": repr(exc)}
        with self.lock:
            self.events.append(rec)

    def _subject(self, kind, node_script, cwd, timeout, done):
        try:
            if kind == "control":
                p = subprocess.Popen(
                    ["cmd.exe", "/c", "ping -n 3 127.0.0.1 >nul"],
                    creationflags=CREATE_NEW_CONSOLE,
                )
                self.result["pid"] = p.pid
                p.wait(timeout=60)
                self.result["rc"] = p.returncode
            else:
                p = subprocess.Popen(
                    ["node", node_script], cwd=cwd,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                )
                self.result["pid"] = p.pid
                try:
                    out, err = p.communicate(timeout=timeout)
                except subprocess.TimeoutExpired:
                    p.kill()
                    out, err = p.communicate()
                    self.result["timed_out"] = True
                self.result["rc"] = p.returncode
                self.result["stdout"] = out
                self.result["stderr"] = err
        except Exception as exc:
            self.result["error"] = repr(exc)
        finally:
            done.set()

    def go(self, kind, node_script=None, cwd=None, seconds=120.0, timeout=90.0):
        cb = WinEventProcType(self._handler)
        self._cb = cb  # keep alive
        hook = user32.SetWinEventHook(
            EVENT_OBJECT_CREATE, EVENT_OBJECT_SHOW, 0, cb, 0, 0,
            WINEVENT_OUTOFCONTEXT,
        )
        if not hook:
            raise OSError("SetWinEventHook failed: %s" % ctypes.get_last_error())

        self.t0 = time.time()
        done = threading.Event()
        msg = w.MSG()

        def drain():
            while user32.PeekMessageW(ctypes.byref(msg), 0, 0, 0, 1):
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))

        settle = time.time() + 0.5
        while time.time() < settle:
            drain()
            time.sleep(0.002)

        threading.Thread(
            target=self._subject,
            args=(kind, node_script, cwd, timeout, done),
            daemon=True,
        ).start()

        hard_stop = self.t0 + seconds
        trailing = None
        while True:
            drain()
            now = time.time()
            if done.is_set() and trailing is None:
                trailing = now + 2.0  # catch teardown windows
            if trailing is not None and now >= trailing:
                break
            if now >= hard_stop:
                break
            time.sleep(0.002)

        user32.UnhookWinEvent(hook)
        with self.lock:
            return list(self.events)


def report(run, captured):
    console_any = [e for e in captured if e.get("cls") in CONSOLE_CLASSES]
    shown = [e for e in console_any if e.get("event") == "SHOW" and e.get("visible")]

    print("=" * 72)
    print("LABEL        :", run.label)
    print("subject pid  :", run.result.get("pid"), "| exit:", run.result.get("rc"),
          "| timed_out:", run.result.get("timed_out", False))
    if run.result.get("error"):
        print("subject error:", run.result["error"])
    print("window events:", len(captured), "(whole desktop)")

    out = (run.result.get("stdout") or "").strip()
    err = (run.result.get("stderr") or "").strip()
    if out:
        print("--- subject stdout ---")
        print(out[:4000])
    if err:
        print("--- subject stderr ---")
        print(err[:2000])

    print("console-class window events :", len(console_any))
    print("  of those SHOWN visible    :", len(shown))
    for e in console_any[:40]:
        print("   +%.3fs %-6s vis=%-5s pid=%-7s %-30s %r" % (
            e["t"] - run.t0, e["event"], e.get("visible"), e.get("pid"),
            e.get("cls"), (e.get("title") or "")[:36]))

    print("PROBE FIRED (any window event) :", bool(captured))
    print("VISIBLE CONSOLE OBSERVED       :", bool(shown))
    print("=" * 72)
    return bool(captured), bool(shown)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sanity", action="store_true")
    ap.add_argument("--control", action="store_true")
    ap.add_argument("--verify", action="store_true",
                    help="control THEN subject; exit 0 only if both hold")
    ap.add_argument("--node", default="test/live/flash-cycles.mjs")
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--seconds", type=float, default=150.0)
    ap.add_argument("--subject-timeout", type=float, default=120.0)
    args = ap.parse_args()

    if args.sanity:
        return 0 if sanity() else 3

    if not sanity():
        print("ABORT: not on an interactive desktop -- the probe cannot see windows.")
        return 3

    if args.control and not args.verify:
        run = Run("POSITIVE CONTROL (cmd.exe, CREATE_NEW_CONSOLE)")
        fired, shown = report(run, run.go("control", seconds=40.0))
        return 0 if shown else 1

    if not args.verify:
        run = Run("SUBJECT %s" % args.node)
        fired, shown = report(
            run, run.go("node", args.node, args.cwd, args.seconds, args.subject_timeout))
        return 1 if shown else 0

    print("### STEP 1/2 -- positive control: the probe must SEE a real console")
    ctl = Run("POSITIVE CONTROL (cmd.exe, CREATE_NEW_CONSOLE)")
    _, ctl_shown = report(ctl, ctl.go("control", seconds=40.0))
    if not ctl_shown:
        print()
        print("RESULT: VOID -- the probe did not detect a console window it created")
        print("itself, so it cannot be trusted to detect one it did not. This is a")
        print("broken instrument, NOT a clean subject.")
        return 2

    print()
    print("### STEP 2/2 -- subject: fancy-pty must show no console window")
    sub = Run("SUBJECT %s" % args.node)
    _, sub_shown = report(
        sub, sub.go("node", args.node, args.cwd, args.seconds, args.subject_timeout))

    print()
    print("control detected a visible console :", ctl_shown, "(required True)")
    print("subject showed a visible console   :", sub_shown, "(required False)")
    ok = ctl_shown and not sub_shown
    print("RESULT:", "PASS -- #4 clean, on a probe proven to fire" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
