// Windows fixture for lookup.live.mjs: print the image path of a pid, asked of
// the OS rather than of the process. A program can claim to be anything; this
// is what Windows actually loaded.

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut core::ffi::c_void;
    fn QueryFullProcessImageNameW(h: *mut core::ffi::c_void, flags: u32, buf: *mut u16, size: *mut u32) -> i32;
    fn CloseHandle(h: *mut core::ffi::c_void) -> i32;
    fn GetLastError() -> u32;
}

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

fn main() {
    let pid: u32 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            println!("ERR open {}", GetLastError());
            std::process::exit(1);
        }
        let mut buf = vec![0u16; 32768];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size);
        CloseHandle(h);
        if ok == 0 {
            println!("ERR query {}", GetLastError());
            std::process::exit(1);
        }
        println!("{}", String::from_utf16_lossy(&buf[..size as usize]));
    }
}
