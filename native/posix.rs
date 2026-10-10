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

use std::ffi::CString;

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

extern "C" {
    fn posix_openpt(flags: i32) -> i32;
    fn grantpt(fd: i32) -> i32;
    fn unlockpt(fd: i32) -> i32;
    fn ptsname(fd: i32) -> *mut i8;
    fn open(path: *const i8, flags: i32, ...) -> i32;
    fn close(fd: i32) -> i32;
    fn read(fd: i32, buf: *mut u8, n: usize) -> isize;
    fn write(fd: i32, buf: *const u8, n: usize) -> isize;
    fn ioctl(fd: i32, request: u64, ...) -> i32;
    fn fork() -> Pid;
    fn setsid() -> Pid;
    fn dup2(old: i32, new: i32) -> i32;
    fn execvp(file: *const i8, argv: *const *const i8) -> i32;
    fn _exit(code: i32) -> !;
    fn waitpid(pid: Pid, status: *mut i32, options: i32) -> Pid;
    fn killpg(pgrp: Pid, sig: i32) -> i32;
    fn pipe(fds: *mut i32) -> i32;
    fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    fn strlen(s: *const i8) -> usize;
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
        let slave_path: Vec<i8> = {
            let len = strlen(slave_name_ptr);
            let mut v = Vec::with_capacity(len + 1);
            std::ptr::copy_nonoverlapping(slave_name_ptr, v.as_mut_ptr(), len + 1);
            v.set_len(len + 1);
            v
        };

        let size = WinSize {
            ws_row: req.rows.max(1),
            ws_col: req.cols.max(1),
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        if ioctl(master.get(), TIOCSWINSZ, &size) != 0 {
            return Err(oserr("ioctl(TIOCSWINSZ)"));
        }

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
        let mut argv_ptrs: Vec<*const i8> = c_argv.iter().map(|c| c.as_ptr()).collect();
        argv_ptrs.push(std::ptr::null());

        let c_env: Vec<CString> = req
            .env
            .iter()
            .map(|(k, v)| CString::new(format!("{k}={v}")))
            .collect::<Result<_, _>>()
            .map_err(|_| "env contains an interior NUL".to_string())?;
        let mut env_ptrs: Vec<*const i8> = c_env.iter().map(|c| c.as_ptr()).collect();
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
                    fn chdir(path: *const i8) -> i32;
                }
                if chdir(cwd.as_ptr()) != 0 {
                    fail(126);
                }
            }

            // `execvpe` is a glibc extension macOS lacks, so set `environ`
            // directly and use `execvp` — which reads it — rather than carrying
            // two code paths.
            extern "C" {
                static mut environ: *const *const i8;
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
        let master_fd = master.into_raw();

        let reader_out = out.clone();
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
                    reader_out.frame(T_ERROR, oserr("read(pty)").as_bytes());
                    break;
                }
                break; // n == 0
            }
        });

        let control_out = out.clone();
        let mut control = control;
        std::thread::spawn(move || loop {
            match read_frame(&mut control) {
                Ok(None) => return,
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
                                return; // the pty is gone; the child is exiting
                            }
                            if w == 0 {
                                return;
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
                        // SIGHUP first: it is what a closing terminal
                        // sends, so a shell gets the chance to run its own
                        // teardown. SIGKILL immediately after, because "asked
                        // nicely" is not a guarantee and this helper must not
                        // outlive its pty.
                        killpg(pgid, SIGHUP);
                        killpg(pgid, SIGKILL);
                        return;
                    }
                    other => control_out.frame(
                        T_ERROR,
                        format!("unknown frame type 0x{other:02x}").as_bytes(),
                    ),
                },
                Err(e) => {
                    control_out.frame(T_ERROR, format!("control stream: {e}").as_bytes());
                    return;
                }
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

        // Closing the master is what ends the reader: the slave side is already
        // gone with the child, and this releases the last reference.
        close(master_fd);
        let _ = reader.join();

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
        Ok(code as u32)
    }
}
