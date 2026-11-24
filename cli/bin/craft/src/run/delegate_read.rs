//! The delegating process's replies as `craft review run --delegate` reads them from stdin: one
//! JSON line each, `{"key":n,"text":…}` or `{"key":n,"error":…}`. A line over [`MAX_LINE`], not
//! UTF-8, or not such a reply is logged, and fails at once the dispatch whose key it opens with (as
//! the plugin writes it, the key first), which waits its deadline otherwise; a line naming no
//! dispatch still waiting is logged. The end of the input, or an error reading it (logged), closes
//! the delegate; an interrupted read is retried.

use std::io::BufRead;

use serde::Deserialize;

use super::{Delegate, Said};

/// The longest reply line read: a task's whole answer fits well within it.
pub(super) const MAX_LINE: usize = 16 * 1024 * 1024;

/// How much of an overlong line is kept, to find the key it opens with.
const HEAD: usize = 64;

/// One reply: an error wins over a text, so a failed turn's partial text is never an answer.
#[derive(Debug, Deserialize)]
struct Reply {
    key: u64,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// One line of the input, its newline cut: `Some(true)` read whole, `Some(false)` over `max` and
/// skipped to its end, its first [`HEAD`] bytes kept, `None` at the end of the input. An
/// interrupted read is tried again.
fn next_line(
    r: &mut impl BufRead,
    max: usize,
    line: &mut Vec<u8>,
) -> std::io::Result<Option<bool>> {
    line.clear();
    let (mut over, mut any) = (false, false);
    loop {
        let chunk = match r.fill_buf() {
            Ok(chunk) => chunk,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if chunk.is_empty() {
            return Ok(any.then_some(!over));
        }
        any = true;
        let end = chunk.iter().position(|b| *b == b'\n');
        let part = chunk.get(..end.unwrap_or(chunk.len())).unwrap_or_default();
        if !over && line.len() + part.len() > max {
            over = true;
            line.truncate(HEAD);
        }
        let take = if over {
            HEAD.saturating_sub(line.len()).min(part.len())
        } else {
            part.len()
        };
        line.extend_from_slice(part.get(..take).unwrap_or_default());
        let used = end.map_or(chunk.len(), |i| i + 1);
        r.consume(used);
        if end.is_some() {
            return Ok(Some(!over));
        }
    }
}

impl Delegate {
    /// Every reply line of `input` handed to its dispatch until the input ends, then the delegate
    /// closed.
    pub(super) fn read_replies(&self, mut input: impl BufRead) {
        let mut line = Vec::new();
        loop {
            let taken = match next_line(&mut input, MAX_LINE, &mut line) {
                Ok(None) => break,
                Err(e) => {
                    (self.0.log)(&format!(
                        "⚠️ delegate: the reply input could not be read ({e}); no later reply can come"
                    ));
                    break;
                }
                Ok(Some(false)) => Err(format!("it is over {MAX_LINE} bytes")),
                Ok(Some(true)) => std::str::from_utf8(&line)
                    .map_err(|_utf8| "it is not UTF-8".to_owned())
                    .and_then(|l| self.deliver(l)),
            };
            if let Err(why) = taken {
                (self.0.log)(&format!("⚠️ delegate: a reply line was passed over: {why}"));
                if let Some(key) = key_in(&line) {
                    self.fail(key, &why);
                }
            }
        }
        self.close();
    }

    /// The dispatch `key` failed at once: its reply could not be read.
    fn fail(&self, key: u64, why: &str) {
        let waiting = self.pending().remove(&key);
        if let Some(tx) = waiting {
            let _gone = tx.send(Err(format!("its reply could not be read: {why}")));
        }
    }

    /// One reply line handed to the dispatch it names; why not when it is no reply or names no
    /// dispatch still waiting.
    pub(crate) fn deliver(&self, line: &str) -> Result<(), String> {
        if line.trim().is_empty() {
            return Ok(());
        }
        let reply: Reply =
            serde_json::from_str(line).map_err(|e| format!("it is not a reply ({e})"))?;
        let said: Said = match (reply.text, reply.error) {
            (_, Some(error)) => Err(error),
            (Some(text), None) => Ok(text),
            (None, None) => {
                return Err(format!(
                    "reply {} carries neither text nor error",
                    reply.key
                ));
            }
        };
        let waiting = self.pending().remove(&reply.key);
        match waiting {
            Some(tx) => tx
                .send(said)
                .map_err(|_gone| format!("task {} is no longer awaited", reply.key)),
            None => Err(format!("no task {} is awaited", reply.key)),
        }
    }
}

/// The key a reply line opens with — `{"key":<n>` within its first [`HEAD`] bytes, as the plugin
/// writes it — even when the rest cannot be read.
fn key_in(line: &[u8]) -> Option<u64> {
    const OPEN: &[u8] = br#"{"key":"#;
    let head = line.get(..line.len().min(HEAD))?.strip_prefix(OPEN)?;
    let digits = head.iter().take_while(|b| b.is_ascii_digit()).count();
    std::str::from_utf8(head.get(..digits)?).ok()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::{key_in, next_line};

    #[test]
    fn the_key_a_line_opens_with_is_found_even_when_the_rest_cannot_be_read() {
        assert_eq!(key_in(br#"{"key":12,"text":"#), Some(12));
        assert_eq!(key_in(b"{\"key\":7,\"text\":\"\xff"), Some(7));
        assert_eq!(
            key_in(br#"{"text":"x","key":3}"#),
            None,
            "not the key first"
        );
        assert_eq!(key_in(br#"{"key":"3"}"#), None);
        assert_eq!(key_in(b""), None);
    }

    #[test]
    fn lines_are_read_whole_an_overlong_one_skipped_to_its_end_and_the_end_said() {
        // A buffer smaller than a line: each line is read across several fills.
        let mut input =
            std::io::BufReader::with_capacity(3, Cursor::new(b"ab\nabcdef\ncd\nef".to_vec()));
        let mut line = Vec::new();
        assert_eq!(next_line(&mut input, 4, &mut line).unwrap(), Some(true));
        assert_eq!(line, b"ab");
        assert_eq!(next_line(&mut input, 4, &mut line).unwrap(), Some(false));
        assert_eq!(line, b"abcdef", "an overlong line's head is kept");
        assert_eq!(next_line(&mut input, 4, &mut line).unwrap(), Some(true));
        assert_eq!(line, b"cd");
        assert_eq!(
            next_line(&mut input, 4, &mut line).unwrap(),
            Some(true),
            "a last line with no newline"
        );
        assert_eq!(line, b"ef");
        assert_eq!(next_line(&mut input, 4, &mut line).unwrap(), None);
    }

    #[test]
    fn an_overlong_line_in_one_read_is_skipped_too() {
        let mut input = Cursor::new(b"abcdef\nab\n".to_vec());
        let mut line = Vec::new();
        assert_eq!(next_line(&mut input, 4, &mut line).unwrap(), Some(false));
        assert_eq!(next_line(&mut input, 4, &mut line).unwrap(), Some(true));
        assert_eq!(line, b"ab");
    }

    #[test]
    fn a_reply_of_a_few_mebibytes_is_read_whole() {
        let big = vec![b'x'; 2 * 1024 * 1024];
        let mut input = Cursor::new([big.as_slice(), b"\n"].concat());
        let mut line = Vec::new();
        assert_eq!(
            next_line(&mut input, super::MAX_LINE, &mut line).unwrap(),
            Some(true)
        );
        assert_eq!(line.len(), big.len());
    }

    #[test]
    fn a_line_exactly_at_the_bound_is_read() {
        let mut input = Cursor::new(b"abcd\n".to_vec());
        let mut line = Vec::new();
        assert_eq!(next_line(&mut input, 4, &mut line).unwrap(), Some(true));
        assert_eq!(line, b"abcd");
    }
}
