use crate::process_identity::{invalid, query, valid};
use std::fmt::Write;
use std::io::{Error, Result};

pub(super) fn name(identity: &str) -> Result<String> {
    let mut bytes = [0_u8; 12];
    getrandom::fill(&mut bytes).map_err(|e| Error::other(e.to_string()))?;
    let mut nonce = String::with_capacity(24);
    for byte in bytes {
        write!(nonce, "{byte:02x}").map_err(Error::other)?;
    }
    Ok(format!("{}-{identity}-{nonce}", std::process::id()))
}

fn parse(name: &str) -> Result<(u32, &str)> {
    let parts: Vec<_> = name.split('-').collect();
    let [pid_text, identity, nonce] = parts.as_slice() else {
        return Err(invalid("invalid index writer ticket"));
    };
    let pid = pid_text
        .parse::<u32>()
        .map_err(|_invalid| invalid("invalid index writer PID"))?;
    if pid == 0
        || pid.to_string() != *pid_text
        || !valid(identity)
        || nonce.len() != 24
        || !nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid("invalid index writer ticket"));
    }
    Ok((pid, identity))
}

pub(super) fn alive(name: &str, own_identity: &str) -> Result<bool> {
    alive_using(name, own_identity, query)
}

fn alive_using(
    name: &str,
    own_identity: &str,
    query_identity: impl FnOnce(u32) -> Result<Option<String>>,
) -> Result<bool> {
    let (pid, identity) = parse(name)?;
    if identity.get(..35) != own_identity.get(..35) {
        return Ok(false);
    }
    Ok(query_identity(pid)?.as_deref() == Some(identity))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn current_pid_requires_the_same_incarnation() {
        let own = query(std::process::id()).unwrap().unwrap();
        let current = name(&own).unwrap();
        assert!(alive(&current, &own).unwrap());
        let incarnation = if own.ends_with("0000000000000000") {
            "1111111111111111"
        } else {
            "0000000000000000"
        };
        let stale = format!("{}{incarnation}", own.get(..36).unwrap());
        assert!(!alive(&current.replace(&own, &stale), &own).unwrap());
    }
    #[test]
    fn different_boot_is_ignored_before_an_invalid_native_pid_is_queried() {
        let own = query(std::process::id()).unwrap().unwrap();
        let other = if own.get(3..35) == Some("00000000000000000000000000000000") {
            "1".repeat(32)
        } else {
            "0".repeat(32)
        };
        let name = format!("4294967295-v1_{other}_0000000000000000-{}", "0".repeat(24));
        assert!(!alive(&name, &own).unwrap());
        assert!(!alive_using(&name, &own, |_| panic!("queried previous-boot PID")).unwrap());
        let same_boot = name.replace(&other, own.get(3..35).unwrap());
        alive_using(&same_boot, &own, |_| {
            Err(Error::new(
                std::io::ErrorKind::PermissionDenied,
                "inaccessible",
            ))
        })
        .unwrap_err();
        for bad in ["1-peer", "0-v1_x-x", "01-v1_x-x"] {
            alive(bad, &own).unwrap_err();
        }
    }
}
