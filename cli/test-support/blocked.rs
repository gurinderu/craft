//! Whether a child process sits blocked reading its stdin, for the stop-on-input probes on Linux
//! (realm @nick/craft, node #738).

/// `read(2)` on `x86_64` and `aarch64`, the number `/proc/<pid>/syscall` starts with.
const READ: &str = if cfg!(target_arch = "aarch64") {
    "63"
} else {
    "0"
};

/// Whether `pid` is blocked reading its stdin: the kernel's wait channel where it names one (a
/// runner's kernel may print `0` there), else the system call it sits in, read from fd 0.
pub fn reading_stdin(pid: u32) -> bool {
    let proc = |f: &str| std::fs::read_to_string(format!("/proc/{pid}/{f}")).unwrap_or_default();
    proc("wchan").trim() == "pipe_read"
        || proc("syscall").split_whitespace().take(2).eq([READ, "0x0"])
}
