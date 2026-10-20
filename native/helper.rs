//! `fancy-pty` helper -- one process per PTY. Zero crates, std only.
//!
//! Build:  rustc -O -C target-feature=+crt-static helper.rs -o fancy-pty-helper.exe
//!
//! The architecture in one line: **a per-pty child process cannot leak into the
//! host.** The 88 GB in Renaissance-Analytics/genie#805 accumulated inside one
//! long-lived Node process at ~12 MB, ~1 thread and ~11 handles retained per
//! exited pty; when a separate helper exits, the OS reclaims all three whether
//! or not our code is tidy. That is a property of the shape, not a promise
//! about the implementation.
//!
//! Protocol: see proto.md. Framed on stdin/stdout, with stderr left free for
//! diagnostics so a crashing helper can still say why.

// Only the Windows backend speaks in raw C pointers; the POSIX one uses
// typed fds, so this would be an unused import there.
#[cfg(windows)]
use std::ffi::c_void;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

// ---------------------------------------------------------------- frame codec

const T_SPAWN: u8 = 0x00;
const T_DATA_IN: u8 = 0x01;
const T_RESIZE: u8 = 0x02;
const T_KILL: u8 = 0x03;

const T_DATA_OUT: u8 = 0x81;
const T_EXIT: u8 = 0x82;
const T_ERROR: u8 = 0x83;
const T_PID: u8 = 0x84;
const T_KILLED: u8 = 0x85;

/// `KILLED` payloads.
const KILLED_GRACEFUL: u8 = 0;
const KILLED_FORCED: u8 = 1;

/// A frame cap, because a length prefix read off a pipe is attacker-shaped data
/// even when the peer is our own JS. 64 MiB is far above any real terminal
/// write and far below anything that threatens the process.
const MAX_FRAME: u32 = 64 * 1024 * 1024;

struct Frame {
    kind: u8,
    payload: Vec<u8>,
}

fn read_frame(r: &mut impl Read) -> std::io::Result<Option<Frame>> {
    let mut head = [0u8; 5];
    if !read_exact_or_eof(r, &mut head)? {
        return Ok(None); // clean EOF between frames
    }
    let kind = head[0];
    let len = u32::from_le_bytes([head[1], head[2], head[3], head[4]]);
    if len > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("frame length {len} over cap"),
        ));
    }
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload)?;
    Ok(Some(Frame { kind, payload }))
}

/// `Ok(false)` only for EOF on the FIRST byte. A partial header is a truncated
/// frame and must be an error -- treating it as EOF would silently drop input.
fn read_exact_or_eof(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<bool> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..])? {
            0 if filled == 0 => return Ok(false),
            0 => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "truncated frame header",
                ))
            }
            n => filled += n,
        }
    }
    Ok(true)
}

/// Every write to our stdout goes through one mutex. The pty reader thread and
/// the exit path both emit frames, and an interleaved write would corrupt the
/// stream in a way the JS side could only see as garbage.
struct Out(Mutex<std::io::Stdout>);

impl Out {
    fn frame(&self, kind: u8, payload: &[u8]) {
        let mut w = match self.0.lock() {
            Ok(w) => w,
            Err(_) => return,
        };
        let mut head = [0u8; 5];
        head[0] = kind;
        head[1..].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        // If the JS side is gone there is nobody to report that to, and the pty
        // teardown still has to run. Swallow, never panic.
        if w.write_all(&head).and_then(|_| w.write_all(payload)).is_err() {
            return;
        }
        let _ = w.flush();
    }
}

// ------------------------------------------------------------ kill lifecycle

/// Who ended the pty, shared between the control thread (which receives KILL),
/// the grace watcher, and the main thread (which reports EXIT).
///
/// Every kill ACTION runs while the lock is held. That is the whole point of
/// the type: the main thread's teardown closes the job handle / reaps the
/// group, and a kill that raced it would act on a handle that no longer names
/// our tree. `close()` moves to `CLOSED` under the same lock, after which no
/// kill acts at all.
struct Lifetime {
    state: Mutex<u8>,
    cv: std::sync::Condvar,
}

const LS_RUNNING: u8 = 0;
const LS_GRACE: u8 = 1;
const LS_GRACEFUL: u8 = 2;
const LS_FORCED: u8 = 3;
const LS_CLOSED: u8 = 4;

impl Lifetime {
    fn new() -> Self {
        Lifetime {
            state: Mutex::new(LS_RUNNING),
            cv: std::sync::Condvar::new(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, u8> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// A hard kill, now. Also ends a grace period early.
    fn force(&self, hard: impl FnOnce()) {
        let mut s = self.lock();
        if *s == LS_RUNNING || *s == LS_GRACE {
            hard();
            *s = LS_FORCED;
            self.cv.notify_all();
        }
    }

    /// Ask nicely. `false` if a kill is already under way or the pty is gone,
    /// in which case the caller starts no watcher.
    fn begin_grace(&self, soft: impl FnOnce()) -> bool {
        let mut s = self.lock();
        if *s != LS_RUNNING {
            return false;
        }
        soft();
        *s = LS_GRACE;
        true
    }

    /// The grace watcher: poll until the tree is EMPTY (graceful) or the
    /// deadline passes (hard kill, forced). "Empty" means the whole job or
    /// process group, not just the direct child -- a worker that exits and
    /// leaves its own children running has not stopped.
    fn watch_grace(&self, grace_ms: u32, empty: impl Fn() -> bool, hard: impl FnOnce()) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(grace_ms as u64);
        loop {
            {
                let mut s = self.lock();
                if *s != LS_GRACE {
                    return;
                }
                if empty() {
                    *s = LS_GRACEFUL;
                    self.cv.notify_all();
                    return;
                }
                if std::time::Instant::now() >= deadline {
                    hard();
                    *s = LS_FORCED;
                    self.cv.notify_all();
                    return;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    /// The controller is gone (F1). Kill the tree unless the main thread is
    /// already past teardown. The caller exits the process afterwards.
    fn controller_gone(&self, hard: impl FnOnce()) {
        let s = self.lock();
        if *s != LS_CLOSED {
            hard();
        }
    }

    /// Main thread, once the child has exited: wait out a grace period in
    /// progress, then stop every later kill from acting. Returns the `KILLED`
    /// payload to report, if any kill ended this pty.
    fn close(&self) -> Option<u8> {
        let mut s = self.lock();
        while *s == LS_GRACE {
            s = self.cv.wait(s).unwrap_or_else(|p| p.into_inner());
        }
        let outcome = match *s {
            LS_GRACEFUL => Some(KILLED_GRACEFUL),
            LS_FORCED => Some(KILLED_FORCED),
            _ => None,
        };
        *s = LS_CLOSED;
        outcome
    }
}

/// `KILL`'s optional payload: `[grace_ms: u32 LE]`. Empty, or zero, is the
/// 0.1.x meaning -- kill now.
fn kill_grace_ms(payload: &[u8]) -> u32 {
    if payload.len() >= 4 {
        u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]])
    } else {
        0
    }
}

// ------------------------------------------------------------- spawn decoding

struct SpawnRequest {
    cols: u16,
    rows: u16,
    cwd: String,
    argv: Vec<String>,
    env: Vec<(String, String)>,
}

struct Cursor<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.at + n > self.b.len() {
            return Err(format!(
                "SPAWN payload truncated: wanted {n} at {} of {}",
                self.at,
                self.b.len()
            ));
        }
        let s = &self.b[self.at..self.at + n];
        self.at += n;
        Ok(s)
    }
    fn u16(&mut self) -> Result<u16, String> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Result<u32, String> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn string(&mut self) -> Result<String, String> {
        let n = self.u32()? as usize;
        let b = self.take(n)?;
        String::from_utf8(b.to_vec()).map_err(|e| format!("invalid utf8 in SPAWN: {e}"))
    }
}

fn decode_spawn(payload: &[u8]) -> Result<SpawnRequest, String> {
    let mut c = Cursor { b: payload, at: 0 };
    let cols = c.u16()?;
    let rows = c.u16()?;
    let cwd = c.string()?;
    // Bound every count BEFORE allocating against it. A 4-byte count read off
    // a pipe is four billion reservations if believed.
    let argc = c.u32()?;
    if argc > 4096 {
        return Err(format!("argc {argc} unreasonable"));
    }
    let mut argv = Vec::with_capacity(argc as usize);
    for _ in 0..argc {
        argv.push(c.string()?);
    }
    let envc = c.u32()?;
    if envc > 65536 {
        return Err(format!("envc {envc} unreasonable"));
    }
    let mut env = Vec::with_capacity(envc as usize);
    for _ in 0..envc {
        let k = c.string()?;
        let v = c.string()?;
        env.push((k, v));
    }
    if argv.is_empty() {
        return Err("SPAWN carried no argv".into());
    }
    if c.at != payload.len() {
        return Err(format!(
            "SPAWN has {} trailing bytes -- version skew between the JS side and the helper",
            payload.len() - c.at
        ));
    }
    Ok(SpawnRequest {
        cols,
        rows,
        cwd,
        argv,
        env,
    })
}

// ------------------------------------------------------- Windows command line

/// Join `argv` the way `CreateProcessW` and the CRT's own parser agree on.
///
/// This exists so no CONSUMER ever has to know these rules. Backslashes are
/// special ONLY immediately before a quote, which is the part everybody gets
/// wrong: `C:\dir\` as a quoted argument must become `"C:\dir\\"`, because
/// `"C:\dir\"` escapes the closing quote and the argument swallows the next one.
///
/// Deliberately NOT escaping `cmd.exe`'s second-pass metacharacters
/// (`&`, `|`, `^`, `<`, `>`). We invoke the program directly, not through
/// `cmd /c`, and pre-escaping them would corrupt arguments for every other
/// program -- a fix for one caller that silently breaks the rest.
fn windows_command_line(argv: &[String]) -> String {
    let mut out = String::new();
    for (i, arg) in argv.iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        let needs_quotes = arg.is_empty()
            || arg.contains(|c: char| {
                c == ' ' || c == '\t' || c == '\n' || c == '\u{000b}' || c == '"'
            });
        if !needs_quotes {
            out.push_str(arg);
            continue;
        }
        out.push('"');
        let chars: Vec<char> = arg.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let mut slashes = 0;
            while i < chars.len() && chars[i] == '\\' {
                slashes += 1;
                i += 1;
            }
            if i == chars.len() {
                // Trailing backslashes: double them, so they cannot escape the
                // closing quote we are about to append.
                for _ in 0..slashes * 2 {
                    out.push('\\');
                }
            } else if chars[i] == '"' {
                for _ in 0..slashes * 2 + 1 {
                    out.push('\\');
                }
                out.push('"');
                i += 1;
            } else {
                for _ in 0..slashes {
                    out.push('\\');
                }
                out.push(chars[i]);
                i += 1;
            }
        }
        out.push('"');
    }
    out
}

fn main() {
    // `--selftest` runs the pure units that need no pty, so the quoting rules
    // above are checkable without Node, a shell, or a console. They are the one
    // part of this program a reader cannot verify by eye.
    if std::env::args().nth(1).as_deref() == Some("--selftest") {
        selftest();
        return;
    }

    // Diagnostic, not a feature. See `posix::probe`.
    #[cfg(unix)]
    if std::env::args().nth(1).as_deref() == Some("--probe-pty") {
        posix::probe();
        return;
    }

    let out = Arc::new(Out(Mutex::new(std::io::stdout())));
    let mut stdin = std::io::stdin();

    let first = match read_frame(&mut stdin) {
        Ok(Some(f)) => f,
        Ok(None) => {
            eprintln!("[fancy-pty] stdin closed before SPAWN");
            std::process::exit(2);
        }
        Err(e) => {
            out.frame(T_ERROR, format!("reading SPAWN: {e}").as_bytes());
            std::process::exit(2);
        }
    };
    if first.kind != T_SPAWN {
        out.frame(
            T_ERROR,
            format!("first frame was 0x{:02x}, expected SPAWN", first.kind).as_bytes(),
        );
        std::process::exit(2);
    }
    let req = match decode_spawn(&first.payload) {
        Ok(r) => r,
        Err(e) => {
            out.frame(T_ERROR, e.as_bytes());
            std::process::exit(2);
        }
    };

    match run(req, out.clone(), stdin) {
        Ok(code) => out.frame(T_EXIT, &code.to_le_bytes()),
        Err(e) => {
            out.frame(T_ERROR, e.as_bytes());
            // An EXIT frame goes out even on failure. The JS side keys cleanup
            // on EXIT, so an error that produced none would turn into a
            // terminal that never closes -- a hang instead of a message.
            out.frame(T_EXIT, &1u32.to_le_bytes());
            std::process::exit(1);
        }
    }
}

fn selftest() {
    let mut failures = 0;
    let mut check = |argv: &[&str], want: &str, why: &str| {
        let owned: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
        let got = windows_command_line(&owned);
        if got == want {
            println!("  ok   {why}");
        } else {
            println!("  FAIL {why}\n       want {want}\n       got  {got}");
            failures += 1;
        }
    };

    check(&["cmd.exe"], "cmd.exe", "a plain program needs no quotes");
    check(
        &["powershell", "-NoLogo"],
        "powershell -NoLogo",
        "flags with no spaces stay bare",
    );
    check(
        &["C:\\Program Files\\Git\\bin\\bash.exe"],
        "\"C:\\Program Files\\Git\\bin\\bash.exe\"",
        "a space forces quotes",
    );
    // The one everybody gets wrong -- but ONLY when the argument is quoted.
    // This pair is deliberately both halves, because the first version of this
    // test asserted the second case looked like the first and went red: the
    // code was right and the expectation was wrong. An unquoted trailing
    // backslash is literal, so doubling it there would CORRUPT the path.
    check(
        &["cmd", "C:\\dir\\"],
        "cmd C:\\dir\\",
        "an unquoted trailing backslash is literal and must be left alone",
    );
    check(
        &["cmd", "C:\\Program Files\\"],
        "cmd \"C:\\Program Files\\\\\"",
        "a trailing backslash IS doubled once a space forced quotes",
    );
    // Proof that it matters: the argument after it must survive intact.
    check(
        &["cmd", "C:\\Program Files\\", "next"],
        "cmd \"C:\\Program Files\\\\\" next",
        "and the following argument is not swallowed by an escaped quote",
    );
    check(
        &["echo", "a\"b"],
        "echo \"a\\\"b\"",
        "an embedded quote is backslash-escaped",
    );
    check(
        &["echo", "a\\\"b"],
        "echo \"a\\\\\\\"b\"",
        "backslash before a quote doubles, then escapes the quote",
    );
    check(&["echo", ""], "echo \"\"", "an empty argument must survive");
    check(
        &["echo", "a\\b"],
        "echo a\\b",
        "a backslash NOT before a quote is ordinary and needs no quoting",
    );

    // Decoder: a truncated SPAWN must be an error, never a partial spawn.
    let truncated = decode_spawn(&[0x50, 0x00, 0x18]);
    if truncated.is_err() {
        println!("  ok   a truncated SPAWN is rejected");
    } else {
        println!("  FAIL a truncated SPAWN decoded anyway");
        failures += 1;
    }
    // And an empty argv, which would otherwise reach CreateProcessW as "".
    let mut p: Vec<u8> = Vec::new();
    p.extend(80u16.to_le_bytes());
    p.extend(24u16.to_le_bytes());
    p.extend(0u32.to_le_bytes()); // cwd ""
    p.extend(0u32.to_le_bytes()); // argc 0
    p.extend(0u32.to_le_bytes()); // envc 0
    match decode_spawn(&p) {
        Err(e) if e.contains("no argv") => println!("  ok   an empty argv is rejected"),
        other => {
            println!("  FAIL an empty argv was accepted: {other:?}");
            failures += 1;
        }
    }

    // KILL payload: empty means the 0.1.x hard kill, so an old JS side that
    // sends no payload keeps exactly the behaviour it had.
    let mut expect = |cond: bool, why: &str| {
        if cond {
            println!("  ok   {why}");
        } else {
            println!("  FAIL {why}");
            failures += 1;
        }
    };
    expect(kill_grace_ms(&[]) == 0, "an empty KILL is a hard kill (0.1.x)");
    expect(
        kill_grace_ms(&10_000u32.to_le_bytes()) == 10_000,
        "a 4-byte KILL carries graceMs",
    );

    // Lifetime: the state machine the three threads share.
    {
        let l = Lifetime::new();
        let mut hit = false;
        l.force(|| hit = true);
        expect(hit, "force() runs the hard kill on a running pty");
        expect(l.close() == Some(KILLED_FORCED), "and close() reports forced");
        let mut after = false;
        l.force(|| after = true);
        expect(!after, "after close() a kill acts on nothing (the handles are gone)");
    }
    {
        let l = Lifetime::new();
        expect(l.begin_grace(|| {}), "begin_grace() starts on a running pty");
        expect(!l.begin_grace(|| {}), "a second graceful kill does not start a second watcher");
        l.watch_grace(1000, || true, || {});
        expect(l.close() == Some(KILLED_GRACEFUL), "an empty tree inside the grace is graceful");
    }
    {
        let l = Lifetime::new();
        l.begin_grace(|| {});
        let mut hard = false;
        l.watch_grace(30, || false, || hard = true);
        expect(hard, "a tree still running at the deadline is hard-killed");
        expect(l.close() == Some(KILLED_FORCED), "and reported forced");
    }
    {
        let l = Lifetime::new();
        expect(l.close().is_none(), "a pty nobody killed reports no KILLED frame");
    }

    if failures == 0 {
        println!("selftest: all green");
    } else {
        println!("selftest: {failures} FAILED");
        std::process::exit(1);
    }
}

impl std::fmt::Debug for SpawnRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "SpawnRequest {{ {}x{}, argv={:?} }}",
            self.cols, self.rows, self.argv
        )
    }
}

// =========================================================== Windows backend

#[cfg(windows)]
mod win {
    use super::*;

    pub type Handle = *mut c_void;
    type Hpcon = *mut c_void;

    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
    const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
    const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
    const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;
    const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
    const JOB_EXTENDED_LIMIT_INFO_CLASS: u32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct Coord {
        pub x: i16,
        pub y: i16,
    }

    #[repr(C)]
    struct StartupInfoW {
        cb: u32,
        lp_reserved: *mut u16,
        lp_desktop: *mut u16,
        lp_title: *mut u16,
        dw_x: u32,
        dw_y: u32,
        dw_x_size: u32,
        dw_y_size: u32,
        dw_x_count_chars: u32,
        dw_y_count_chars: u32,
        dw_fill_attribute: u32,
        dw_flags: u32,
        w_show_window: u16,
        cb_reserved2: u16,
        lp_reserved2: *mut u8,
        h_std_input: Handle,
        h_std_output: Handle,
        h_std_error: Handle,
    }

    #[repr(C)]
    struct StartupInfoExW {
        startup_info: StartupInfoW,
        lp_attribute_list: *mut c_void,
    }

    #[repr(C)]
    struct ProcessInformation {
        h_process: Handle,
        h_thread: Handle,
        dw_process_id: u32,
        dw_thread_id: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct JobBasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct JobExtendedLimitInformation {
        basic: JobBasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreatePipe(r: *mut Handle, w: *mut Handle, a: *const c_void, size: u32) -> i32;
        fn CreatePseudoConsole(
            size: Coord,
            h_in: Handle,
            h_out: Handle,
            flags: u32,
            pc: *mut Hpcon,
        ) -> i32;
        fn ClosePseudoConsole(pc: Hpcon);
        fn ResizePseudoConsole(pc: Hpcon, size: Coord) -> i32;
        fn InitializeProcThreadAttributeList(
            l: *mut c_void,
            count: u32,
            flags: u32,
            size: *mut usize,
        ) -> i32;
        fn UpdateProcThreadAttribute(
            l: *mut c_void,
            flags: u32,
            attribute: usize,
            value: *mut c_void,
            size: usize,
            prev: *mut c_void,
            ret: *mut usize,
        ) -> i32;
        fn DeleteProcThreadAttributeList(l: *mut c_void);
        fn CreateProcessW(
            app: *const u16,
            cmd: *mut u16,
            pa: *const c_void,
            ta: *const c_void,
            inherit: i32,
            flags: u32,
            env: *mut c_void,
            cwd: *const u16,
            si: *mut StartupInfoExW,
            pi: *mut ProcessInformation,
        ) -> i32;
        fn ReadFile(h: Handle, b: *mut u8, n: u32, read: *mut u32, o: *mut c_void) -> i32;
        fn WriteFile(h: Handle, b: *const u8, n: u32, written: *mut u32, o: *mut c_void) -> i32;
        fn CloseHandle(h: Handle) -> i32;
        fn GetLastError() -> u32;
        fn GetExitCodeProcess(h: Handle, code: *mut u32) -> i32;
        fn WaitForSingleObject(h: Handle, ms: u32) -> u32;
        fn CreateJobObjectW(a: *const c_void, name: *const u16) -> Handle;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, code: u32) -> i32;
        fn SetInformationJobObject(job: Handle, class: u32, info: *mut c_void, len: u32) -> i32;
        fn QueryInformationJobObject(
            job: Handle,
            class: u32,
            info: *mut c_void,
            len: u32,
            ret: *mut u32,
        ) -> i32;
        fn TerminateProcess(h: Handle, code: u32) -> i32;
        fn ResumeThread(h: Handle) -> u32;
        fn SetConsoleCtrlHandler(handler: *const c_void, add: i32) -> i32;
    }

    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    const JOB_BASIC_ACCOUNTING_INFO_CLASS: u32 = 1;
    const WAIT_OBJECT_0: u32 = 0;

    #[repr(C)]
    #[derive(Default)]
    struct JobBasicAccountingInformation {
        total_user_time: i64,
        total_kernel_time: i64,
        this_period_total_user_time: i64,
        this_period_total_kernel_time: i64,
        total_page_fault_count: u32,
        total_processes: u32,
        active_processes: u32,
        total_terminated_processes: u32,
    }

    /// The tree, as one thing to kill or to ask "is anyone left".
    ///
    /// `in_job` is false only if the job could not be created or the child
    /// could not be assigned; then the direct child is all we can reach, and
    /// saying so in the code beats a TerminateJobObject on an empty job that
    /// reports success and kills nothing.
    #[derive(Clone, Copy)]
    struct Tree {
        job: SendHandle,
        child: SendHandle,
        in_job: bool,
    }

    impl Tree {
        unsafe fn hard_kill(&self) {
            if self.in_job {
                TerminateJobObject(self.job.0, 1);
            } else {
                TerminateProcess(self.child.0, 1);
            }
        }

        unsafe fn empty(&self) -> bool {
            if !self.in_job {
                return WaitForSingleObject(self.child.0, 0) == WAIT_OBJECT_0;
            }
            let mut info = JobBasicAccountingInformation::default();
            let ok = QueryInformationJobObject(
                self.job.0,
                JOB_BASIC_ACCOUNTING_INFO_CLASS,
                &mut info as *mut _ as *mut c_void,
                std::mem::size_of::<JobBasicAccountingInformation>() as u32,
                std::ptr::null_mut(),
            );
            // A failed query is "not known to be empty", never "empty": the
            // safe misreading ends in a hard kill at the deadline, the unsafe
            // one would report a graceful stop with the tree still running.
            ok != 0 && info.active_processes == 0
        }
    }

    /// TEST-ONLY: widen the gap between creating the child and assigning it to
    /// the job, so `test/live/lifecycle.live.mjs` (F3) hits the race on every
    /// run instead of once in a blue moon. Read from the HELPER's environment,
    /// never the child's (that one comes from SPAWN). Capped at 10 s. Unset in
    /// every real deployment, where it costs one env lookup.
    fn test_only_assign_delay() -> u64 {
        std::env::var("FANCY_PTY_TEST_ONLY_ASSIGN_DELAY_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(|v| v.min(10_000))
            .unwrap_or(0)
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    const ERROR_FILE_NOT_FOUND: u32 = 2;
    const ERROR_PATH_NOT_FOUND: u32 = 3;
    const ERROR_ACCESS_DENIED: u32 = 5;

    /// Explain a failed spawn in terms of the thing the caller passed.
    ///
    /// `CreateProcessW failed (GetLastError=2)` is accurate and tells a
    /// consumer nothing. Worth the words because node-pty's version of this
    /// error is `File not found: ` with NOTHING after the colon (the wide
    /// string prints empty), measured by `claude - tynn` on Windows the same
    /// day: an error that names neither the program nor the reason sends the
    /// reader looking for a missing file that is sitting right there.
    ///
    /// THE RULE, measured rather than assumed -- the first version of this
    /// function asserted that a `.cmd` cannot be spawned directly, and that is
    /// FALSE. What is true:
    ///
    ///   * `CreateProcessW` appends `.exe` and NOTHING else. So a bare `cmd`
    ///     resolves and a bare `npm` does not, because npm on Windows is
    ///     `npm.cmd`.
    ///   * With the extension present, a `.cmd` / `.bat` runs fine -- Windows
    ///     invokes it through the command processor itself. `hello.cmd` works;
    ///     `hello` does not.
    ///
    /// So the advice is just "pass the extension", which is both simpler and
    /// correct. The wrong version would have sent a consumer to wrap every
    /// script in `cmd.exe /c` for no reason.
    fn spawn_error(program: &str) -> String {
        let code = unsafe { GetLastError() };
        let hint = match code {
            ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => {
                if std::path::Path::new(program).extension().is_none() {
                    " -- not found on PATH. CreateProcessW appends .exe and NOTHING else,                      so a command that is really a .cmd or .bat (npm, npx, yarn) does not                      resolve bare: pass the extension (\"npm.cmd\"), or run it through a                      shell (argv: [\"cmd.exe\", \"/c\", \"npm\", ...])"
                } else {
                    " -- not found on PATH"
                }
            }
            ERROR_ACCESS_DENIED => " -- access denied",
            _ => "",
        };
        format!("cannot start {program:?} (CreateProcessW GetLastError={code}){hint}")
    }

    fn last(what: &str) -> String {
        format!("{what} failed (GetLastError={})", unsafe { GetLastError() })
    }

    /// Handles shared with the pump threads. Raw pointers are not `Send`;
    /// wrapping them says plainly "the OS guarantees these for the lifetime of
    /// this function", rather than laundering them through `as usize` at every
    /// thread boundary where the next reader has to re-derive why it is safe.
    #[derive(Clone, Copy)]
    struct SendHandle(Handle);
    unsafe impl Send for SendHandle {}
    unsafe impl Sync for SendHandle {}

    pub fn run(req: SpawnRequest, out: Arc<Out>, control: std::io::Stdin) -> Result<u32, String> {
        unsafe {
            // RE-ENABLE Ctrl-C before creating the command, or F4's graceful
            // kill cannot work. The JS side spawns this helper detached, and
            // libuv's detached flags include CREATE_NEW_PROCESS_GROUP, which
            // starts the process with Ctrl-C IGNORED. That setting is
            // INHERITED, so every command under the pty ignored the Ctrl-C
            // that `kill({ graceMs })` types: the first green-everything-else
            // CI run showed a worker with a SIGINT handler sitting out the
            // full 10 s grace and being forced. NULL + FALSE is the documented
            // way to clear the flag, and our children inherit the cleared one.
            SetConsoleCtrlHandler(std::ptr::null(), 0);

            let mut pty_in_read = INVALID_HANDLE_VALUE;
            let mut our_write = INVALID_HANDLE_VALUE;
            let mut our_read = INVALID_HANDLE_VALUE;
            let mut pty_out_write = INVALID_HANDLE_VALUE;

            if CreatePipe(&mut pty_in_read, &mut our_write, std::ptr::null(), 0) == 0 {
                return Err(last("CreatePipe(in)"));
            }
            if CreatePipe(&mut our_read, &mut pty_out_write, std::ptr::null(), 0) == 0 {
                return Err(last("CreatePipe(out)"));
            }

            let mut hpcon: Hpcon = std::ptr::null_mut();
            let size = Coord {
                x: req.cols.max(1) as i16,
                y: req.rows.max(1) as i16,
            };
            if CreatePseudoConsole(size, pty_in_read, pty_out_write, 0, &mut hpcon) != 0 {
                return Err("CreatePseudoConsole failed".into());
            }

            let mut list_size: usize = 0;
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut list_size);
            let mut list_buf = vec![0u8; list_size];
            let list = list_buf.as_mut_ptr() as *mut c_void;
            if InitializeProcThreadAttributeList(list, 1, 0, &mut list_size) == 0 {
                return Err(last("InitializeProcThreadAttributeList"));
            }
            if UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                hpcon,
                std::mem::size_of::<Hpcon>(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(last("UpdateProcThreadAttribute(PSEUDOCONSOLE)"));
            }

            let mut si = StartupInfoExW {
                startup_info: StartupInfoW {
                    cb: std::mem::size_of::<StartupInfoExW>() as u32,
                    lp_reserved: std::ptr::null_mut(),
                    lp_desktop: std::ptr::null_mut(),
                    lp_title: std::ptr::null_mut(),
                    dw_x: 0,
                    dw_y: 0,
                    dw_x_size: 0,
                    dw_y_size: 0,
                    dw_x_count_chars: 0,
                    dw_y_count_chars: 0,
                    dw_fill_attribute: 0,
                    // THE ANSWER to the child-stdio problem is this flag plus
                    // the three NULLs below. Omitting the flag does not mean
                    // "no opinion" -- it means "propagate the parent's std
                    // handles", which is how the spawned shell ends up reading
                    // the HELPER's stdin (our control channel) instead of the
                    // pseudoconsole, and writing its banner to the helper's
                    // stdout (our frame stream). Setting the flag with NULL
                    // handles is the only way to say "the child has none", and
                    // csrss then hands it the pseudoconsole's own. Verified by
                    // the child's screen buffer reading back the size we asked
                    // for -- a value an inherited handle cannot fake.
                    dw_flags: STARTF_USESTDHANDLES,
                    w_show_window: 0,
                    cb_reserved2: 0,
                    lp_reserved2: std::ptr::null_mut(),
                    h_std_input: std::ptr::null_mut(),
                    h_std_output: std::ptr::null_mut(),
                    h_std_error: std::ptr::null_mut(),
                },
                lp_attribute_list: list,
            };

            let mut cmdline = wide(&windows_command_line(&req.argv));
            let cwd = if req.cwd.is_empty() {
                None
            } else {
                Some(wide(&req.cwd))
            };
            let mut env_block = env_block(&req.env);

            let mut pi = ProcessInformation {
                h_process: std::ptr::null_mut(),
                h_thread: std::ptr::null_mut(),
                dw_process_id: 0,
                dw_thread_id: 0,
            };

            // A job object, so KILL takes the whole tree rather than just the
            // shell, and KILL_ON_JOB_CLOSE so the tree dies with the helper
            // even if the helper is killed outright. That is the orphan
            // guarantee: there is no path where the helper goes away and the
            // shell survives, which is where 31 stuck OpenConsole.exe
            // processes came from.
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if !job.is_null() {
                let mut info = JobExtendedLimitInformation::default();
                info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    JOB_EXTENDED_LIMIT_INFO_CLASS,
                    &mut info as *mut _ as *mut c_void,
                    std::mem::size_of::<JobExtendedLimitInformation>() as u32,
                );
            }

            let created = CreateProcessW(
                std::ptr::null(),
                cmdline.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                // CREATE_SUSPENDED (F3): the child must be IN the job before
                // it executes a single instruction. Assigning after it runs
                // leaves a window in which anything it spawns is born outside
                // the job, and then neither KILL nor KILL_ON_JOB_CLOSE can
                // reach it -- the tree kill silently becomes a shell kill.
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
                env_block.as_mut_ptr() as *mut c_void,
                cwd.as_ref().map(|c| c.as_ptr()).unwrap_or(std::ptr::null()),
                &mut si,
                &mut pi,
            );
            DeleteProcThreadAttributeList(list);
            if created == 0 {
                let e = spawn_error(&req.argv[0]);
                ClosePseudoConsole(hpcon);
                return Err(e);
            }
            let delay = test_only_assign_delay();
            if delay > 0 {
                std::thread::sleep(std::time::Duration::from_millis(delay));
            }
            let in_job = !job.is_null() && AssignProcessToJobObject(job, pi.h_process) != 0;

            // The command's own pid (F2b), before any output can arrive, so a
            // consumer holding `childPid` has it by the first `onData`.
            out.frame(T_PID, &pi.dw_process_id.to_le_bytes());

            if ResumeThread(pi.h_thread) == u32::MAX {
                let e = last("ResumeThread");
                TerminateProcess(pi.h_process, 1);
                ClosePseudoConsole(hpcon);
                return Err(e);
            }

            // The pseudoconsole owns its ends now. Holding our copies open
            // means the read below never sees EOF.
            CloseHandle(pty_in_read);
            CloseHandle(pty_out_write);

            let child = SendHandle(pi.h_process);
            let reader_h = SendHandle(our_read);
            let writer_h = SendHandle(our_write);
            let pcon = SendHandle(hpcon);
            let job_h = SendHandle(job);
            let tree = Tree {
                job: job_h,
                child,
                in_job,
            };
            let life = Arc::new(Lifetime::new());

            // Reader: pty -> framed stdout. It MUST be its own thread. EOF here
            // arrives only when ClosePseudoConsole runs, so draining on the
            // thread that has to perform that close deadlocks -- the spike hung
            // for two minutes proving exactly this.
            let out_r = out.clone();
            let reader = std::thread::spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    let mut n: u32 = 0;
                    let ok = ReadFile(
                        reader_h.0,
                        buf.as_mut_ptr(),
                        buf.len() as u32,
                        &mut n,
                        std::ptr::null_mut(),
                    );
                    if ok == 0 || n == 0 {
                        break;
                    }
                    out_r.frame(T_DATA_OUT, &buf[..n as usize]);
                }
            });

            // Control: framed stdin -> pty writes, resizes, kill. Detached on
            // purpose -- it blocks in a read that only the JS side can end, so
            // joining it would make every clean exit wait for the consumer.
            //
            // It must keep reading for the helper's WHOLE life, because its
            // EOF is the only way the helper learns the controller died (F1).
            // So nothing in here returns except that.
            let out_c = out.clone();
            let life_c = life.clone();
            let mut control = control;
            std::thread::spawn(move || loop {
                match read_frame(&mut control) {
                    // THE CONTROLLER IS GONE (F1) -- crashed, killed, or closed
                    // the channel. Nobody can read this pty or ever kill it, so
                    // take the tree down and go. Before 0.2.0 this thread just
                    // returned and the main thread went on waiting for a shell
                    // that nobody would ever end. On Windows that was masked,
                    // not fixed: a Node controller spawned the helper
                    // non-detached, so libuv's kill-on-close job took the
                    // helper down with it (CI measured 0 survivors on 0.1.4 on
                    // Windows and 10/10/10 on every POSIX runner). 0.2.0 spawns
                    // detached (F2), so this is now the only guard there too.
                    //
                    // A broken stream counts too: after a truncated or
                    // oversized frame there is no way back into sync, so the
                    // channel is as good as closed. Said first, in case anyone
                    // is still reading.
                    Ok(None) => {
                        life_c.controller_gone(|| tree.hard_kill());
                        std::process::exit(1);
                    }
                    Err(e) => {
                        out_c.frame(T_ERROR, format!("control stream: {e}").as_bytes());
                        life_c.controller_gone(|| tree.hard_kill());
                        std::process::exit(1);
                    }
                    Ok(Some(f)) => match f.kind {
                        T_DATA_IN => {
                            let mut at = 0usize;
                            while at < f.payload.len() {
                                let mut w: u32 = 0;
                                let ok = WriteFile(
                                    writer_h.0,
                                    f.payload[at..].as_ptr(),
                                    (f.payload.len() - at) as u32,
                                    &mut w,
                                    std::ptr::null_mut(),
                                );
                                if ok == 0 || w == 0 {
                                    // The pty is gone and the child is exiting.
                                    // Expected, not an error worth a frame --
                                    // drop the rest of this write, keep
                                    // listening for the controller.
                                    break;
                                }
                                at += w as usize;
                            }
                        }
                        T_RESIZE => {
                            if f.payload.len() != 4 {
                                out_c.frame(T_ERROR, b"RESIZE payload must be 4 bytes");
                                continue;
                            }
                            let cols = u16::from_le_bytes([f.payload[0], f.payload[1]]);
                            let rows = u16::from_le_bytes([f.payload[2], f.payload[3]]);
                            ResizePseudoConsole(
                                pcon.0,
                                Coord {
                                    x: cols.max(1) as i16,
                                    y: rows.max(1) as i16,
                                },
                            );
                        }
                        T_KILL => {
                            let grace = kill_grace_ms(&f.payload);
                            if grace == 0 {
                                life_c.force(|| tree.hard_kill());
                            } else if life_c.begin_grace(|| {
                                // Ctrl-C, typed into the pseudoconsole (F4).
                                // conhost turns it into CTRL_C_EVENT for every
                                // process on the console -- the same thing a
                                // person pressing Ctrl-C in the terminal does.
                                let etx = [0x03u8];
                                let mut w: u32 = 0;
                                WriteFile(writer_h.0, etx.as_ptr(), 1, &mut w, std::ptr::null_mut());
                            }) {
                                let life_w = life_c.clone();
                                std::thread::spawn(move || {
                                    life_w.watch_grace(grace, || tree.empty(), || tree.hard_kill());
                                });
                            }
                        }
                        other => out_c.frame(
                            T_ERROR,
                            format!("unknown frame type 0x{other:02x}").as_bytes(),
                        ),
                    },
                }
            });

            WaitForSingleObject(child.0, u32::MAX);
            let mut code: u32 = 0;
            GetExitCodeProcess(child.0, &mut code);

            // A graceful kill is not over when the direct child exits: the
            // watcher decides once the whole JOB is empty (or forces it), and
            // the job handle must stay open until it has.
            let killed = life.close();

            // Order matters, and this is the fix the spike paid for: the child
            // is gone, so closing the pseudoconsole is what gives the reader
            // its EOF. Join only after.
            ClosePseudoConsole(pcon.0);
            let _ = reader.join();

            CloseHandle(writer_h.0);
            CloseHandle(pi.h_process);
            CloseHandle(pi.h_thread);
            if !job_h.0.is_null() {
                CloseHandle(job_h.0);
            }
            if let Some(how) = killed {
                out.frame(T_KILLED, &[how]);
            }
            Ok(code)
        }
    }

    /// A UTF-16 environment block: `K=V\0K=V\0\0`.
    ///
    /// Passed explicitly rather than inherited, so a pty's environment is
    /// exactly what the caller asked for. A helper that silently merged its own
    /// would make terminal behaviour depend on how the APP was launched, which
    /// is invisible from the consumer's side and impossible to reproduce.
    fn env_block(env: &[(String, String)]) -> Vec<u16> {
        let mut b: Vec<u16> = Vec::new();
        for (k, v) in env {
            b.extend(k.encode_utf16());
            b.push('=' as u16);
            b.extend(v.encode_utf16());
            b.push(0);
        }
        // The block terminator. With no variables at all this leaves a single
        // NUL, which is the empty-block form CreateProcessW expects.
        b.push(0);
        b
    }
}

#[cfg(windows)]
fn run(req: SpawnRequest, out: Arc<Out>, control: std::io::Stdin) -> Result<u32, String> {
    win::run(req, out, control)
}

// ============================================================= POSIX backend

#[cfg(unix)]
mod posix {
    use super::*;
    include!("posix.rs");
}

#[cfg(unix)]
fn run(req: SpawnRequest, out: Arc<Out>, control: std::io::Stdin) -> Result<u32, String> {
    posix::run(req, out, control)
}

// Neither Windows nor unix. There is no third branch that could work, so this
// refuses rather than returning a success nobody can act on: a backend that
// reported Ok would claim a working terminal carrying nothing, which is the
// failure shape this whole package exists to stop shipping.
#[cfg(not(any(windows, unix)))]
fn run(_req: SpawnRequest, _out: Arc<Out>, _control: std::io::Stdin) -> Result<u32, String> {
    Err("fancy-pty: no backend for this platform".into())
}
