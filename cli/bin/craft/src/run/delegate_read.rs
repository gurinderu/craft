//! The delegating process's replies as `craft review run --delegate` reads them from stdin: one
//! JSON line each, `{"key":n,"text":…}` or `{"key":n,"error":…}`. A line over [`MAX_LINE`], not
//! UTF-8, not such a reply, or naming no dispatch still waiting is passed over and logged; only
//! the end of the input closes the delegate.

use std::io::BufRead;

use serde::Deserialize;

use super::{Delegate, Said};

/// The longest reply line read: a task's whole answer fits well within it.
pub(super) const MAX_LINE: usize = 16 * 1024 * 1024;

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
/// skipped to its end, `None` at the end of the input.
fn next_line(
    r: &mut impl BufRead,
    max: usize,
    line: &mut Vec<u8>,
) -> std::io::Result<Option<bool>> {
    line.clear();
    let (mut over, mut any) = (false, false);
    loop {
        let chunk = r.fill_buf()?;
        if chunk.is_empty() {
            return Ok(any.then_some(!over));
        }
        any = true;
        let end = chunk.iter().position(|b| *b == b'\n');
        let part = chunk.get(..end.unwrap_or(chunk.len())).unwrap_or_default();
        if !over && line.len() + part.len() > max {
            over = true;
            line.clear();
        }
        if !over {
            line.extend_from_slice(part);
        }
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
            match next_line(&mut input, MAX_LINE, &mut line) {
                Ok(None) | Err(_) => break,
                Ok(Some(false)) => (self.0.log)(&format!(
                    "⚠️ delegate: a reply line over {MAX_LINE} bytes was passed over"
                )),
                Ok(Some(true)) => {
                    let taken = std::str::from_utf8(&line)
                        .map_err(|_utf8| "it is not UTF-8".to_owned())
                        .and_then(|l| self.deliver(l));
                    if let Err(why) = taken {
                        (self.0.log)(&format!("⚠️ delegate: a reply line was passed over: {why}"));
                    }
                }
            }
        }
        self.close();
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

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::next_line;

    #[test]
    fn lines_are_read_whole_an_overlong_one_skipped_to_its_end_and_the_end_said() {
        // A buffer smaller than a line: each line is read across several fills.
        let mut input =
            std::io::BufReader::with_capacity(3, Cursor::new(b"ab\nabcdef\ncd\nef".to_vec()));
        let mut line = Vec::new();
        assert_eq!(next_line(&mut input, 4, &mut line).unwrap(), Some(true));
        assert_eq!(line, b"ab");
        assert_eq!(next_line(&mut input, 4, &mut line).unwrap(), Some(false));
        assert!(line.is_empty());
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
