// Windows fixture for check 6d in pty.live.mjs: report what this process REALLY
// received, as numbers.
//
// Built by the suite with rustc (no crates, same as the helper). A Node fixture
// would not do: Node exposes only the CRT's parse of the command line, and the
// parse is what hides the difference between `\"` and `"` at the front of a
// path. GetCommandLineW is the string CreateProcessW was given.
//
// Two channels are deliberately avoided. The report goes to a FILE named by
// FANCY_PTY_ECHO_OUT, not through the pty, because ConPTY re-renders and wraps
// what it carries. And everything is UTF-16 code units in a JSON number array,
// so no escape layer on the way to the reader can alter a backslash or a quote.
//
// One appended line per run, so a test can count how many processes ran and
// which image each one was.

use std::fs::OpenOptions;
use std::io::Write;
use std::os::windows::ffi::OsStrExt;

#[link(name = "kernel32")]
extern "system" {
    fn GetCommandLineW() -> *const u16;
}

fn numbers(units: &[u16]) -> String {
    let joined: Vec<String> = units.iter().map(|u| u.to_string()).collect();
    format!("[{}]", joined.join(","))
}

fn main() {
    let raw: Vec<u16> = unsafe {
        let p = GetCommandLineW();
        let mut n = 0;
        while *p.add(n) != 0 {
            n += 1;
        }
        std::slice::from_raw_parts(p, n).to_vec()
    };
    let exe: Vec<u16> = std::env::current_exe()
        .map(|p| p.as_os_str().encode_wide().collect())
        .unwrap_or_default();
    let argv: Vec<String> = std::env::args_os()
        .map(|a| numbers(&a.encode_wide().collect::<Vec<u16>>()))
        .collect();

    let line = format!(
        "{{\"exe\":{},\"raw\":{},\"argv\":[{}]}}\n",
        numbers(&exe),
        numbers(&raw),
        argv.join(",")
    );

    let Some(path) = std::env::var_os("FANCY_PTY_ECHO_OUT") else {
        std::process::exit(3);
    };
    let mut f = OpenOptions::new().create(true).append(true).open(path).unwrap();
    f.write_all(line.as_bytes()).unwrap();
}
