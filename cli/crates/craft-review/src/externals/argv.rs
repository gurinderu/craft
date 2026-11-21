use super::{Error, text};
use craft_store::js::{self, Js, JsString};
use std::path::{Path, PathBuf};

const USAGE: &str = "usage: craft-externals discover --repo-root <absolute dir> [--paths <base64url JSON list>] [--known -]";
const MEMORY_USAGE: &str = "usage: craft-externals memory --repo-root <absolute dir> (the external records as JSON on stdin)";

/// The validated original helper arguments; roots need not be Git repositories.
#[derive(Debug)]
pub struct Invocation {
    /// Canonical filesystem root (including the legacy regular-file-root case).
    pub root: PathBuf,
    /// Explicit paths, in their input order, without deduplication.
    pub paths: Option<Vec<JsString>>,
    /// Whether discovery reads stdin as known records.
    pub known: bool,
    /// Whether this is the legacy import verb.
    pub memory: bool,
}

impl Invocation {
    /// Validate helper argv before reading stdin, preserving its exit-1 refusal contract.
    /// # Errors
    /// Invalid options, paths, or a missing root.
    pub fn parse(args: &[String]) -> Result<Self, Error> {
        if args.first().is_some_and(|v| v == "memory") {
            return Self::memory(args);
        }
        if args.first().is_none_or(|v| v != "discover") || args.len() % 2 != 1 {
            return Err(Error::refused(USAGE));
        }
        let mut options = std::collections::HashMap::new();
        for [key, value] in args.iter().skip(1).collect::<Vec<_>>().as_chunks::<2>().0 {
            if !["--repo-root", "--paths", "--known"].contains(&key.as_str())
                || options.insert(key.as_str(), value.as_str()).is_some()
            {
                return Err(Error::refused(format!(
                    "unexpected option {}",
                    Js::str(*key).compact()
                )));
            }
        }
        Self::discover(&options)
    }

    fn discover(options: &std::collections::HashMap<&str, &str>) -> Result<Self, Error> {
        let root = options.get("--repo-root").copied().unwrap_or("");
        if !Path::new(root).is_absolute() {
            return Err(Error::refused(
                "--repo-root is missing or not an absolute path",
            ));
        }
        let known = options.contains_key("--known");
        if known && options.get("--known") != Some(&"-") {
            return Err(Error::refused(
                "--known takes only \"-\" (the records as JSON on stdin)",
            ));
        }
        let paths = options
            .get("--paths")
            .map(|v| decode_paths(v))
            .transpose()?;
        Ok(Self {
            root: root_of(root)?,
            paths,
            known,
            memory: false,
        })
    }

    fn memory(args: &[String]) -> Result<Self, Error> {
        let [_, option, root] = args else {
            return Err(Error::refused(MEMORY_USAGE));
        };
        if option != "--repo-root" {
            return Err(Error::refused(MEMORY_USAGE));
        }
        if !Path::new(root).is_absolute() {
            return Err(Error::refused("--repo-root is not an absolute path"));
        }
        Ok(Self {
            root: root_of(root)?,
            paths: None,
            known: false,
            memory: true,
        })
    }
}

fn root_of(root: &str) -> Result<PathBuf, Error> {
    std::fs::canonicalize(root)
        .map_err(|_io| Error::refused(format!("--repo-root {root} does not exist")))
}

fn decode_paths(encoded: &str) -> Result<Vec<JsString>, Error> {
    let refused = || Error::refused("--paths is not base64url JSON of 1..24 repo-relative paths");
    let bytes = decode_base64(encoded).ok_or_else(refused)?;
    let value = js::parse(&String::from_utf8_lossy(&bytes)).map_err(|_json| refused())?;
    let list = value
        .as_arr()
        .filter(|l| !l.is_empty() && l.len() <= 24)
        .ok_or_else(refused)?;
    list.iter()
        .map(|v| {
            let Js::Str(s) = v else {
                return Err(refused());
            };
            let path = text::lossy(s);
            if s.is_empty() || Path::new(&path).is_absolute() || path.split('/').any(|s| s == "..")
            {
                return Err(refused());
            }
            Ok(s.clone())
        })
        .collect()
}

// Buffer's unpadded base64url decoding ignores unused trailing bits and a final lone sextet.
fn decode_base64(encoded: &str) -> Option<Vec<u8>> {
    if encoded.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    let (mut bits, mut count) = (0_u32, 0_u32);
    for byte in encoded.bytes() {
        let n = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        bits = (bits << 6) | u32::from(n);
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push(u8::try_from((bits >> count) & 255).ok()?);
        }
    }
    Some(out)
}
