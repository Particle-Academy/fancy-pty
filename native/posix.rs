// The POSIX backend, included into helper.rs under #[cfg(unix)].
//
// macOS and Linux: posix_openpt / grantpt / unlockpt / ptsname, then
// fork + setsid + ioctl(TIOCSCTTY) + dup2 + execvp. Zero crates — these are
// libc symbols, and Rust links libc already, so hand-written `extern "C"`
// declarations need nothing added.
//
// THE RULE THAT GOVERNS THIS FILE: between `fork()` and `execvp()` the child
// may only call async-signal-safe functions. No allocation, no formatting, no
// locking, no Rust `String` work, nothing that could touch the allocator a
// forked thread might hold. Everything the child needs is therefore built as C
// strings and pointer arrays BEFORE the fork, and the child's code path below
// is deliberately dull. This is the single easiest place in the package to
// write a bug that appears only under concurrency.

use std::ffi::c_char;
use std::sync::atomic::{AtomicBool, Ordering};
use std::ffi::CString;

// `c_char` rather than `i8`, everywhere a C string is involved.
//
// **`c_char` is UNSIGNED on aarch64-linux and SIGNED on x86_64-linux and
// macOS.** Hardcoding `i8` compiled on four of our six targets and failed only
// on `linux-arm64` — caught by CI's arm64 runner on this file's first real
// build. The six-target matrix exists for exactly this: a type whose width is
// the same everywhere and whose SIGN is not.

type Pid = i32;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct WinSize {
    ws_row: u16,
    ws_col: u16,
    ws_xpixel: u16,
    ws_ypixel: u16,
}

// ioctl request numbers are NOT portable: they encode direction and payload
// size, so the BSD and Linux encodings differ entirely. Writing one set and
// assuming the other compiles cleanly and fails at runtime on exactly one
// platform — a `cfg` branch is the one kind of code a typecheck cannot vouch
// for, because only one arm is ever compiled on any given machine.
//
// PROVENANCE, because these are magic numbers and a wrong one is a runtime-only
// failure:
//
//   Linux  — READ OFF THE SYSTEM HEADERS (`sys/ioctl.h`, `fcntl.h`) via a C
//            program on Ubuntu 24.04, 2026-10-10. TIOCSWINSZ 0x5414,
//            TIOCSCTTY 0x540e, O_RDWR 0x2, O_NOCTTY 0x100 (== 0o400),
//            F_SETFD 2, FD_CLOEXEC 1, and sizeof(struct winsize) == 8, which
//            is what makes the `WinSize` struct below the right shape.
//
//   macOS  — DERIVED from the BSD `_IOW`/`_IO` encoding, not read from headers:
//            `_IOW('t',103,struct winsize)` = 0x80000000|(8<<16)|('t'<<8)|103
//            = 0x80087467, and `_IO('t',97)` = 0x20000000|('t'<<8)|97
//            = 0x20007461. Sound, but a derivation rather than a measurement —
//            so the macOS CI job is the first real exercise of this arm, and
//            that is deliberately where it gets proven rather than asserted.
#[cfg(target_os = "linux")]
const TIOCSWINSZ: u64 = 0x5414;
#[cfg(target_os = "linux")]
const TIOCSCTTY: u64 = 0x540e;

#[cfg(any(target_os = "macos", target_os = "ios"))]
const TIOCSWINSZ: u64 = 0x8008_7467;
#[cfg(any(target_os = "macos", target_os = "ios"))]
const TIOCSCTTY: u64 = 0x2000_7461;

const O_RDWR: i32 = 0x0002;
#[cfg(target_os = "linux")]
const O_NOCTTY: i32 = 0o400;
#[cfg(any(target_os = "macos", target_os = "ios"))]
const O_NOCTTY: i32 = 0x20000;

const F_SETFD: i32 = 2;
const FD_CLOEXEC: i32 = 1;
const EIO: i32 = 5;
const EINTR: i32 = 4;
const SIGKILL: i32 = 9;
const SIGHUP: i32 = 1;
// SIGTERM and ESRCH are the same number on Linux and macOS.
const SIGTERM: i32 = 15;
const ESRCH: i32 = 3;

extern "C" {
    fn posix_openpt(flags: i32) -> i32;
    fn grantpt(fd: i32) -> i32;
    fn unlockpt(fd: i32) -> i32;
    fn ptsname(fd: i32) -> *mut c_char;
    fn open(path: *const c_char, flags: i32, ...) -> i32;
    fn close(fd: i32) -> i32;
    fn read(fd: i32, buf: *mut u8, n: usize) -> isize;
    fn write(fd: i32, buf: *const u8, n: usize) -> isize;
    fn ioctl(fd: i32, request: u64, ...) -> i32;
    fn fork() -> Pid;
    fn setsid() -> Pid;
    fn dup2(old: i32, new: i32) -> i32;
    fn execvp(file: *const c_char, argv: *const *const c_char) -> i32;
    fn _exit(code: i32) -> !;
    fn waitpid(pid: Pid, status: *mut i32, options: i32) -> Pid;
    fn killpg(pgrp: Pid, sig: i32) -> i32;
    fn kill(pid: Pid, sig: i32) -> i32;
    fn pipe(fds: *mut i32) -> i32;
    fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    fn strlen(s: *const c_char) -> usize;
}

/// The pty's process group: the child is its leader (`setsid`), so its pid
/// IS the pgid, and every descendant that did not leave the group is in it.
#[derive(Clone, Copy)]
struct Group(Pid);

impl Group {
    /// SIGHUP then SIGKILL: what a closing terminal sends, then the guarantee.
    fn hard_kill(&self) {
        unsafe {
            killpg(self.0, SIGHUP);
            killpg(self.0, SIGKILL);
        }
    }

    /// Nobody left in the group. `kill(-pgid, 0)` fails with ESRCH exactly
    /// then; any other answer (including success on a not-yet-reaped zombie
    /// leader) is "not known to be empty", which errs toward a forced kill at
    /// the deadline rather than a false "graceful".
    fn empty(&self) -> bool {
        unsafe { kill(-self.0, 0) != 0 && errno() == ESRCH }
    }
}

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn oserr(what: &str) -> String {
    format!("{what} failed: {}", std::io::Error::last_os_error())
}

/// A file descriptor that closes itself. Without this, every `return Err(...)`
/// on the way through `run` is a leaked fd — and in a one-pty-per-process
/// helper that would be invisible, because the process exits immediately after.
/// It would then become a real leak the moment anyone reused the helper, which
/// is exactly the kind of latent defect this package exists to avoid.
struct Fd(i32);

impl Fd {
    fn get(&self) -> i32 {
        self.0
    }
    fn into_raw(self) -> i32 {
        let fd = self.0;
        std::mem::forget(self);
        fd
    }
}

impl Drop for Fd {
    fn drop(&mut self) {
        if self.0 >= 0 {
            unsafe { close(self.0) };
        }
    }
}

/// NOTE: the whole body is one `unsafe` block, and that scope extends
/// lexically into the closures below -- so the thread bodies are unsafe too
/// and carry no inner markers (rustc warns on the redundant ones). Read every
/// libc call in here as unsafe, including the ones inside the pump threads.
pub fn run(req: SpawnRequest, out: Arc<Out>, control: std::io::Stdin) -> Result<u32, String> {
    unsafe {
        // O_NOCTTY on the MASTER: opening it must not make it our controlling
        // terminal. The child claims the slave as its own below, and a helper
        // that had grabbed a controlling terminal first would get signals meant
        // for the pty's foreground group.
        let master = Fd(posix_openpt(O_RDWR | O_NOCTTY));
        if master.get() < 0 {
            return Err(oserr("posix_openpt"));
        }
        if grantpt(master.get()) != 0 {
            return Err(oserr("grantpt"));
        }
        if unlockpt(master.get()) != 0 {
            return Err(oserr("unlockpt"));
        }

        // `ptsname` rather than `ptsname_r`: the reentrant form is a glibc
        // extension that macOS only grew recently, and this is called before
        // any thread is spawned, so the static buffer cannot be raced. The
        // name is copied immediately for the same reason.
        let slave_name_ptr = ptsname(master.get());
        if slave_name_ptr.is_null() {
            return Err(oserr("ptsname"));
        }
        let slave_path: Vec<c_char> = {
            let len = strlen(slave_name_ptr);
            let mut v = Vec::with_capacity(len + 1);
            std::ptr::copy_nonoverlapping(slave_name_ptr, v.as_mut_ptr(), len + 1);
            v.set_len(len + 1);
            v
        };

        // The initial size is applied by the CHILD, on the slave fd, not here on
        // the master — and that ordering is a MEASURED requirement rather than
        // a preference.
        //
        // `ioctl(master, TIOCSWINSZ)` before any slave is open works on Linux
        // and returns **ENOTTY on macOS**: the master does not accept terminal
        // ioctls until the slave side exists. Established by `--probe-pty` on a
        // macOS CI runner, which separated it from the other credible cause —
        // the AArch64 Apple variadic ABI — by declaring the same `ioctl` symbol
        // a second time non-variadically and getting the identical ENOTTY. The
        // constant (0x80087467) was never wrong; the ORDER was.
        //
        // Built before the fork, deliberately: the child may not allocate, and
        // a Copy struct on the parent's stack is simply there in the child's
        // copied address space.
        let size = WinSize {
            ws_row: req.rows.max(1),
            ws_col: req.cols.max(1),
            ws_xpixel: 0,
            ws_ypixel: 0,
        };

        // --------------------------------------------------------------------
        // Everything the child needs, built BEFORE the fork.
        //
        // After `fork()` the child may only call async-signal-safe functions.
        // Allocating, formatting a string, or taking a lock there can deadlock
        // against a mutex another thread held at the instant of the fork — a
        // failure that appears only under load and never in a test that spawns
        // one pty.
        // --------------------------------------------------------------------
        let c_argv: Vec<CString> = req
            .argv
            .iter()
            .map(|a| CString::new(a.as_bytes()))
            .collect::<Result<_, _>>()
            .map_err(|_| "argv contains an interior NUL".to_string())?;
        let mut argv_ptrs: Vec<*const c_char> = c_argv.iter().map(|c| c.as_ptr()).collect();
        argv_ptrs.push(std::ptr::null());

        let c_env: Vec<CString> = req
            .env
            .iter()
            .map(|(k, v)| CString::new(format!("{k}={v}")))
            .collect::<Result<_, _>>()
            .map_err(|_| "env contains an interior NUL".to_string())?;
        let mut env_ptrs: Vec<*const c_char> = c_env.iter().map(|c| c.as_ptr()).collect();
        env_ptrs.push(std::ptr::null());

        let c_cwd = if req.cwd.is_empty() {
            None
        } else {
            Some(CString::new(req.cwd.as_bytes()).map_err(|_| "cwd contains a NUL".to_string())?)
        };

        // How the parent learns that `execvp` failed.
        //
        // Without this, a failed exec is indistinguishable from a shell that
        // ran and exited 127 — the child is already forked, so the pty opens,
        // reports an exit, and the consumer sees an empty terminal that closed
        // itself. The pipe is CLOEXEC, so a SUCCESSFUL exec closes it and the
        // parent reads EOF; a failure writes errno through it first.
        let mut err_fds = [-1i32; 2];
        if pipe(err_fds.as_mut_ptr()) != 0 {
            return Err(oserr("pipe"));
        }
        let err_read = Fd(err_fds[0]);
        let err_write = Fd(err_fds[1]);
        if fcntl(err_write.get(), F_SETFD, FD_CLOEXEC) != 0 {
            return Err(oserr("fcntl(FD_CLOEXEC)"));
        }

        let child = fork();
        if child < 0 {
            return Err(oserr("fork"));
        }

        if child == 0 {
            // ---------------- CHILD ----------------
            // Async-signal-safe calls only, no allocation, and `_exit` rather
            // than `exit` on every failure path so no atexit handler or
            // buffered stream inherited from the parent is ever flushed twice.
            let fail = |code: i32| -> ! {
                let e = errno();
                let bytes = (e as u32).to_le_bytes();
                let _ = write(err_write.get(), bytes.as_ptr(), 4);
                _exit(code);
            };

            // A new session, so this process has NO controlling terminal and
            // can claim the pty's slave as one. Without setsid, TIOCSCTTY
            // fails and the shell gets no job control: Ctrl-C would do nothing
            // and the pty would look subtly broken rather than broken.
            if setsid() < 0 {
                fail(126);
            }

            let slave = open(slave_path.as_ptr(), O_RDWR, 0);
            if slave < 0 {
                fail(126);
            }

            // Claim it as the controlling terminal. This is the call that makes
            // the pty a real terminal rather than a pair of pipes.
            if ioctl(slave, TIOCSCTTY, 0) != 0 {
                fail(126);
            }

            // The window size, now that a slave exists. Setting it on the
            // slave rather than the master works on both platforms, where the
            // master-side call works on only one.
            if ioctl(slave, TIOCSWINSZ, &size) != 0 {
                fail(126);
            }

            if dup2(slave, 0) < 0 || dup2(slave, 1) < 0 || dup2(slave, 2) < 0 {
                fail(126);
            }
            if slave > 2 {
                close(slave);
            }
            // The master must NOT survive into the child. If it did, the
            // parent's read would never see EOF when the shell exits, because
            // the shell's own copy would hold the pty open — a terminal that
            // never closes.
            close(master.get());
            close(err_read.get());

            if let Some(cwd) = &c_cwd {
                extern "C" {
                    fn chdir(path: *const c_char) -> i32;
                }
                if chdir(cwd.as_ptr()) != 0 {
                    fail(126);
                }
            }

            // `execvpe` is a glibc extension macOS lacks, so set `environ`
            // directly and use `execvp` — which reads it — rather than carrying
            // two code paths.
            extern "C" {
                static mut environ: *const *const c_char;
            }
            environ = env_ptrs.as_ptr();

            execvp(argv_ptrs[0], argv_ptrs.as_ptr());
            // Only reachable if exec failed.
            fail(127);
        }

        // ---------------- PARENT ----------------
        drop(err_write); // our copy, so the read below can reach EOF

        // Did exec fail? Four bytes means errno; EOF means the exec succeeded.
        let mut buf = [0u8; 4];
        let n = loop {
            let n = read(err_read.get(), buf.as_mut_ptr(), 4);
            if n < 0 && errno() == EINTR {
                continue;
            }
            break n;
        };
        if n == 4 {
            let code = i32::from_le_bytes(buf);
            let mut status: i32 = 0;
            waitpid(child, &mut status, 0);
            return Err(format!(
                "failed to start {:?}: {}",
                req.argv[0],
                std::io::Error::from_raw_os_error(code)
            ));
        }
        drop(err_read);

        // `setsid` made the child a session AND process-group leader, so its
        // pgid equals its pid. That is what lets KILL take the whole tree
        // rather than just the shell, which is the POSIX equivalent of the job
        // object on Windows.
        let pgid = child;
        let group = Group(pgid);
        let life = Arc::new(Lifetime::new());
        let master_fd = master.into_raw();

        // The command's own pid (F2b), before any output can arrive.
        out.frame(T_PID, &(child as u32).to_le_bytes());

        // Set immediately before we close the master, so the reader can tell
        // "the fd went away because WE closed it" from a genuine fault. Without
        // it a teardown race surfaces to the consumer as an error frame on a
        // perfectly healthy pty.
        let tearing_down = Arc::new(AtomicBool::new(false));

        // The reader signals here the instant it has drained. That is what lets
        // the close WAIT for the drain instead of racing it.
        let (drained_tx, drained_rx) = std::sync::mpsc::channel::<()>();

        let reader_out = out.clone();
        let reader_flag = tearing_down.clone();
        let reader = std::thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            loop {
                let n = read(master_fd, buf.as_mut_ptr(), buf.len());
                if n > 0 {
                    reader_out.frame(T_DATA_OUT, &buf[..n as usize]);
                    continue;
                }
                if n < 0 {
                    let e = errno();
                    if e == EINTR {
                        continue;
                    }
                    // **EIO is EOF here, not an error.** When the last slave fd
                    // closes, Linux fails the master read with EIO rather than
                    // returning 0. Reporting it as a fault would make every
                    // normal shell exit look like a crash — and on macOS the
                    // same event returns 0, so a backend tested only there
                    // would ship with Linux terminals that always "error".
                    if e == EIO {
                        break;
                    }
                    // EBADF because the teardown below closed the fd under us
                    // is expected and silent; EBADF at any other time is a
                    // real fault and still reported.
                    if !reader_flag.load(Ordering::SeqCst) {
                        reader_out.frame(T_ERROR, oserr("read(pty)").as_bytes());
                    }
                    break;
                }
                break; // n == 0
            }
            let _ = drained_tx.send(());
        });

        // Control thread. It must keep reading for the helper's whole life:
        // EOF on this stream is the only way the helper learns its controller
        // died (F1), so nothing in here returns.
        let control_out = out.clone();
        let control_life = life.clone();
        let mut control = control;
        std::thread::spawn(move || loop {
            match read_frame(&mut control) {
                // THE CONTROLLER IS GONE (F1). Before 0.2.0 this thread
                // returned and the main thread kept waiting on a shell nobody
                // could ever end -- so a crashed consumer left every pty and
                // its whole tree running, and its successor started duplicates.
                // SIGHUP first (a closing terminal), a short grace, then
                // SIGKILL, then exit.
                Ok(None) => {
                    control_life.controller_gone(|| controller_gone_kill(group));
                    std::process::exit(1);
                }
                // A broken stream is as closed as a closed one: there is no
                // way back into frame sync after it.
                Err(e) => {
                    control_out.frame(T_ERROR, format!("control stream: {e}").as_bytes());
                    control_life.controller_gone(|| controller_gone_kill(group));
                    std::process::exit(1);
                }
                Ok(Some(f)) => match f.kind {
                    T_DATA_IN => {
                        let mut at = 0usize;
                        while at < f.payload.len() {
                            let w =
                                write(master_fd, f.payload[at..].as_ptr(), f.payload.len() - at);
                            if w < 0 {
                                if errno() == EINTR {
                                    continue;
                                }
                                break; // the pty is gone; the child is exiting
                            }
                            if w == 0 {
                                break;
                            }
                            at += w as usize;
                        }
                    }
                    T_RESIZE => {
                        if f.payload.len() != 4 {
                            control_out.frame(T_ERROR, b"RESIZE payload must be 4 bytes");
                            continue;
                        }
                        let cols = u16::from_le_bytes([f.payload[0], f.payload[1]]);
                        let rows = u16::from_le_bytes([f.payload[2], f.payload[3]]);
                        let size = WinSize {
                            ws_row: rows.max(1),
                            ws_col: cols.max(1),
                            ws_xpixel: 0,
                            ws_ypixel: 0,
                        };
                        ioctl(master_fd, TIOCSWINSZ, &size);
                        // SIGWINCH to the foreground group, or the shell never
                        // learns. The ioctl changes what `stty size` reports;
                        // only the signal makes a running program re-read it,
                        // and a resize that updates the kernel but not the app
                        // is the version of this bug that looks like it works.
                        killpg(pgid, 28); // SIGWINCH
                    }
                    T_KILL => {
                        let grace = kill_grace_ms(&f.payload);
                        if grace == 0 {
                            // 0.1.x behaviour: SIGHUP then SIGKILL, no gap.
                            control_life.force(|| group.hard_kill());
                        } else if control_life.begin_grace(|| {
                            // F4. SIGTERM to the whole group: what a process
                            // supervisor sends, and what `queue:work` and most
                            // workers treat as "finish the current job, then
                            // stop". (An INTERACTIVE shell ignores SIGTERM, so
                            // a bare shell will run to the deadline and be
                            // reported "forced" -- which is the truth.)
                            killpg(pgid, SIGTERM);
                        }) {
                            let watch_life = control_life.clone();
                            std::thread::spawn(move || {
                                watch_life.watch_grace(grace, || group.empty(), || group.hard_kill());
                            });
                        }
                    }
                    other => control_out.frame(
                        T_ERROR,
                        format!("unknown frame type 0x{other:02x}").as_bytes(),
                    ),
                },
            }
        });

        let mut status: i32 = 0;
        loop {
            let r = waitpid(child, &mut status, 0);
            if r < 0 && errno() == EINTR {
                continue;
            }
            break;
        }

        // The leader is reaped. A graceful kill is still not over until the
        // whole GROUP is empty, which the watcher decides (or forces).
        let killed = life.close();

        // DRAIN FIRST, THEN CLOSE -- the opposite order loses output, and CI
        // caught it rather than review.
        //
        // The master read ends by itself once every slave fd is closed: EIO on
        // Linux, 0 on macOS. Closing the master immediately after `waitpid`
        // instead RACES the reader, and for a command that exits in 2 ms the
        // reader has not yet read anything, so it takes EBADF and **the
        // command's entire output is lost**. On Linux CI that showed up as
        // `read(pty) failed: Bad file descriptor` plus a silently empty
        // terminal for `sh -c echo`; the same code had passed on a previous run
        // and on arm64, which is what a race looks like.
        //
        // Bounded, because "wait for the drain" alone would hang if a
        // GRANDCHILD still holds the slave open after the shell exits -- a
        // backgrounded process is enough. So: wait briefly for the natural end,
        // and force it only if that does not come.
        let drained = drained_rx
            .recv_timeout(std::time::Duration::from_millis(2000))
            .is_ok();
        tearing_down.store(true, Ordering::SeqCst);
        close(master_fd);
        let _ = reader.join();
        let _ = drained;

        // WIFEXITED / WEXITSTATUS / WTERMSIG, open-coded because they are
        // macros and there is nothing to link against. A signalled child
        // reports 128+signal, which is the shell convention a consumer already
        // reads — rather than 0, which is what dropping the signal case would
        // give and would make a killed terminal look like a clean exit.
        let code = if status & 0x7f == 0 {
            (status >> 8) & 0xff
        } else {
            128 + (status & 0x7f)
        };
        if let Some(how) = killed {
            out.frame(T_KILLED, &[how]);
        }
        Ok(code as u32)
    }
}

/// F1's teardown: SIGHUP (a closing terminal -- the shell's cue to run its own
/// teardown), up to 250 ms for the group to empty, then SIGKILL regardless.
/// Short, because nobody is waiting on the far side: the controller is dead.
fn controller_gone_kill(group: Group) {
    unsafe {
        killpg(group.0, SIGHUP);
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
    while !group.empty() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    unsafe {
        killpg(group.0, SIGKILL);
    }
}

// ============================================================ ioctl PROBE
//
// `--probe-pty`. Exists because macOS CI returned ENOTTY from
// `ioctl(master, TIOCSWINSZ)` and there are two credible causes, which no
// amount of reading can separate:
//
//   A. THE VARIADIC ABI. On AArch64 Apple, a variadic function's variadic
//      arguments are passed on the STACK, not in registers. If Rust's variadic
//      `extern "C"` declaration and libc's `va_arg` disagree, the request or
//      the pointer arrives mangled -- and a mangled request number produces
//      exactly ENOTTY, because the kernel simply does not recognise it.
//
//   B. ORDERING. The master may not accept terminal ioctls until the SLAVE
//      side has been opened, since that is what attaches the tty state. Linux
//      plainly does not require this; BSD might.
//
// So the probe tests each one, and reports instead of concluding. This is the
// same move that settled the Windows child-stdio question in one run after a
// confident wrong theory: when a diagnosis stalls, stop reasoning about the
// subject and get it to REPORT. `cmd.exe` reported failure by doing nothing,
// and so does an ioctl that only ever returns -1.
//
// It runs on LINUX too, deliberately. The Linux constants are known-good
// (read off the system headers), so Linux output is the positive control: if
// the probe says "A fails" there as well, the probe is broken, not the ioctl.

// Two declarations of one symbol with different signatures is exactly what is
// being tested, so the warning is the mechanism rather than a mistake. Scoped
// to this block so it cannot hide a real clash elsewhere.
#[allow(clashing_extern_declarations)]
#[cfg(unix)]
extern "C" {
    /// The SAME symbol, declared NON-variadic.
    ///
    /// On AArch64 Apple this changes where the third argument goes -- register
    /// instead of stack -- so a difference in outcome between this and the
    /// variadic declaration above IS cause A, measured rather than argued.
    #[link_name = "ioctl"]
    fn ioctl_fixed(fd: i32, request: u64, arg: *const WinSize) -> i32;
    fn isatty(fd: i32) -> i32;
}

pub fn probe() {
    unsafe {
        println!("fancy-pty ioctl probe");
        println!(
            "  target: {} / {}",
            std::env::consts::OS,
            std::env::consts::ARCH
        );
        println!("  TIOCSWINSZ = 0x{TIOCSWINSZ:x}");
        println!("  TIOCSCTTY  = 0x{TIOCSCTTY:x}");

        let master = posix_openpt(O_RDWR | O_NOCTTY);
        println!("  posix_openpt -> fd {master}");
        if master < 0 {
            println!("  FATAL: {}", std::io::Error::last_os_error());
            return;
        }
        println!("  grantpt  -> {}", grantpt(master));
        println!("  unlockpt -> {}", unlockpt(master));
        println!("  isatty(master) -> {}", isatty(master));

        let size = WinSize { ws_row: 31, ws_col: 97, ws_xpixel: 0, ws_ypixel: 0 };

        // A, before any slave exists.
        let a = ioctl(master, TIOCSWINSZ, &size);
        println!(
            "  [A] variadic decl, no slave open  -> {a}  errno={}",
            if a == 0 { "-".to_string() } else { format!("{}", std::io::Error::last_os_error()) }
        );

        // A', the non-variadic declaration of the same symbol.
        let b = ioctl_fixed(master, TIOCSWINSZ, &size);
        println!(
            "  [A'] NON-variadic decl, no slave  -> {b}  errno={}",
            if b == 0 { "-".to_string() } else { format!("{}", std::io::Error::last_os_error()) }
        );

        // B: open the slave, then retry both.
        let name = ptsname(master);
        if name.is_null() {
            println!("  ptsname -> NULL: {}", std::io::Error::last_os_error());
            return;
        }
        let len = strlen(name);
        let mut path: Vec<c_char> = Vec::with_capacity(len + 1);
        std::ptr::copy_nonoverlapping(name, path.as_mut_ptr(), len + 1);
        path.set_len(len + 1);
        let slave = open(path.as_ptr(), O_RDWR | O_NOCTTY, 0);
        println!("  slave open -> fd {slave}");

        let c = ioctl(master, TIOCSWINSZ, &size);
        println!(
            "  [B] variadic decl, slave OPEN     -> {c}  errno={}",
            if c == 0 { "-".to_string() } else { format!("{}", std::io::Error::last_os_error()) }
        );

        let d = if slave >= 0 { ioctl(slave, TIOCSWINSZ, &size) } else { -1 };
        println!(
            "  [C] on the SLAVE fd               -> {d}  errno={}",
            if d == 0 { "-".to_string() } else { format!("{}", std::io::Error::last_os_error()) }
        );

        println!();
        println!("  VERDICT:");
        if a == 0 {
            println!("    the original call works here; this platform is not the problem");
        } else if b == 0 {
            println!("    cause A -- the VARIADIC declaration is wrong on this ABI.");
            println!("    Fix: declare ioctl non-variadically for the fixed 3-arg form.");
        } else if c == 0 || d == 0 {
            println!("    cause B -- ORDERING. The size must be set once a slave exists");
            println!("    (master-after-slave: {}, slave fd: {}).", c == 0, d == 0);
        } else {
            println!("    NEITHER. The constant itself is wrong, or something else is.");
        }

        if slave >= 0 {
            close(slave);
        }
        close(master);
    }
}
