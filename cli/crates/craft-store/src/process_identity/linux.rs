use super::{invalid, uuid};
use std::io::{ErrorKind, Result};

pub(super) fn query(pid: u32) -> Result<Option<(String, u64)>> {
    let signed = i32::try_from(pid).map_err(|_invalid| invalid("invalid process identity PID"))?;
    let boot = uuid(std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim())?;
    let text = read_result(std::fs::read_to_string(format!("/proc/{pid}/stat")), signed)?;
    text.map(|text| stat(&text, pid))
        .transpose()
        .map(|ticks| ticks.flatten().map(|n| (boot, n)))
}

fn read_result(result: Result<String>, signed: i32) -> Result<Option<String>> {
    match result {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            if nix::sys::signal::kill(nix::unistd::Pid::from_raw(signed), None)
                == Err(nix::errno::Errno::ESRCH)
            {
                return Ok(None);
            }
            Err(e)
        }
        Err(e) => Err(e),
    }
}

fn stat(text: &str, pid: u32) -> Result<Option<u64>> {
    let (_, rest) = text
        .rsplit_once(") ")
        .ok_or_else(|| invalid("invalid process stat identity"))?;
    if !text.starts_with(&format!("{pid} (")) {
        return Err(invalid("invalid process stat PID"));
    }
    let fields: Vec<_> = rest.split_whitespace().collect();
    let state = fields.first().copied().unwrap_or("");
    if state.len() != 1 || !"RSDZTtXxKWPI".contains(state) {
        return Err(invalid("invalid process stat state"));
    }
    let ticks = fields
        .get(19)
        .ok_or_else(|| invalid("missing process stat starttime"))?;
    let n = ticks
        .parse::<u64>()
        .map_err(|_invalid| invalid("invalid process stat starttime"))?;
    if n.to_string() != *ticks {
        return Err(invalid("noncanonical process stat starttime"));
    }
    if matches!(state, "Z" | "X" | "x") {
        return Ok(None);
    }
    Ok(Some(n))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_or_inaccessible_live_proc_is_not_death() {
        let pid = i32::try_from(std::process::id()).unwrap();
        for kind in [
            ErrorKind::PermissionDenied,
            ErrorKind::NotFound,
            ErrorKind::InvalidData,
        ] {
            let error = std::io::Error::new(kind, "identity unavailable");
            assert_eq!(read_result(Err(error), pid).unwrap_err().kind(), kind);
        }
    }
    #[test]
    fn stat_uses_last_parenthesis_and_refuses_bad_or_overflowed_starttime() {
        let prefix = format!("42 (a ) b) S {}", "0 ".repeat(18));
        assert_eq!(
            stat(&format!("{prefix}18446744073709551615 0"), 42).unwrap(),
            Some(u64::MAX)
        );
        for ticks in ["18446744073709551616", "01", "-1", "no", ""] {
            stat(&format!("{prefix}{ticks}"), 42).unwrap_err();
        }
        stat(&format!("{prefix}1"), 43).unwrap_err();
        assert_eq!(
            stat(&format!("{prefix}1").replace(") S", ") Z"), 42).unwrap(),
            None
        );
    }
}
