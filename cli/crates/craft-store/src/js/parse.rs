//! `JSON.parse`: the text as JavaScript reads it — every number a double, a key set twice holding
//! its last value at its first place. Strings retain every UTF-16 code unit (realm @nick/craft, #560).

use super::{Js, JsString, Obj};

/// Why a text is not JSON, and where.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{what} at position {at}")]
pub struct ParseError {
    pub what: &'static str,
    pub at: usize,
}

/// The value `text` holds.
///
/// # Errors
/// When `text` is not one JSON value with only whitespace around it.
pub fn parse(text: &str) -> Result<Js, ParseError> {
    let mut p = Parser {
        s: text.as_bytes(),
        text,
        i: 0,
    };
    let v = p.value(0)?;
    p.ws();
    if p.i < p.s.len() {
        return Err(p.err("unexpected text after the value"));
    }
    Ok(v)
}

/// Deeper nesting than any record holds is refused rather than recursed into.
const MAX_DEPTH: usize = 512;

struct Parser<'a> {
    s: &'a [u8],
    text: &'a str,
    i: usize,
}

impl Parser<'_> {
    fn err(&self, what: &'static str) -> ParseError {
        ParseError { what, at: self.i }
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn eat(&mut self, word: &str) -> Result<(), ParseError> {
        if self.s.get(self.i..self.i + word.len()) == Some(word.as_bytes()) {
            self.i += word.len();
            Ok(())
        } else {
            Err(self.err("unexpected token"))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Js, ParseError> {
        if depth > MAX_DEPTH {
            return Err(self.err("nested too deep"));
        }
        self.ws();
        match self.peek() {
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => self.string().map(Js::str),
            Some(b't') => self.eat("true").map(|()| Js::Bool(true)),
            Some(b'f') => self.eat("false").map(|()| Js::Bool(false)),
            Some(b'n') => self.eat("null").map(|()| Js::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => Err(self.err("unexpected token")),
            None => Err(self.err("unexpected end of JSON input")),
        }
    }

    fn object(&mut self, depth: usize) -> Result<Js, ParseError> {
        self.i += 1;
        let mut o = Obj::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.i += 1;
            return Ok(Js::Obj(o));
        }
        loop {
            self.ws();
            if self.peek() != Some(b'"') {
                return Err(self.err("expected a property name"));
            }
            let k = self.string()?;
            self.ws();
            self.eat(":")?;
            let v = self.value(depth + 1)?;
            o.set(k, v);
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Js::Obj(o));
                }
                _ => return Err(self.err("expected ',' or '}'")),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Js, ParseError> {
        self.i += 1;
        let mut a = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.i += 1;
            return Ok(Js::Arr(a));
        }
        loop {
            a.push(self.value(depth + 1)?);
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Js::Arr(a));
                }
                _ => return Err(self.err("expected ',' or ']'")),
            }
        }
    }

    fn number(&mut self) -> Result<Js, ParseError> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        match self.peek() {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => self.digits(),
            _ => return Err(self.err("no number after minus sign")),
        }
        if self.peek() == Some(b'.') {
            self.i += 1;
            self.required_digits()?;
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            self.required_digits()?;
        }
        let text = self.text.get(start..self.i).unwrap_or("");
        text.parse::<f64>()
            .ok()
            .map(Js::Num)
            .ok_or_else(|| self.err("bad number"))
    }

    fn digits(&mut self) {
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.i += 1;
        }
    }

    fn required_digits(&mut self) -> Result<(), ParseError> {
        let at = self.i;
        self.digits();
        if self.i == at {
            Err(self.err("expected a digit"))
        } else {
            Ok(())
        }
    }

    fn string(&mut self) -> Result<JsString, ParseError> {
        self.i += 1;
        let mut out = Vec::new();
        loop {
            let run = self.i;
            while matches!(self.peek(), Some(c) if c != b'"' && c != b'\\' && c >= 0x20) {
                self.i += 1;
            }
            out.extend(self.text.get(run..self.i).unwrap_or("").encode_utf16());
            match self.peek() {
                Some(b'"') => {
                    self.i += 1;
                    return Ok(JsString::from_utf16(out));
                }
                Some(b'\\') => {
                    self.i += 1;
                    out.push(self.escape()?);
                }
                Some(_) => return Err(self.err("bad control character in string")),
                None => return Err(self.err("unterminated string")),
            }
        }
    }

    fn escape(&mut self) -> Result<u16, ParseError> {
        let c = self.peek().ok_or_else(|| self.err("unterminated string"))?;
        self.i += 1;
        Ok(match c {
            b'"' => u16::from(b'"'),
            b'\\' => u16::from(b'\\'),
            b'/' => u16::from(b'/'),
            b'b' => 8,
            b'f' => 12,
            b'n' => 10,
            b'r' => 13,
            b't' => 9,
            b'u' => return self.hex4(),
            _ => return Err(self.err("bad escaped character")),
        })
    }

    fn hex4(&mut self) -> Result<u16, ParseError> {
        let h = self
            .text
            .get(self.i..self.i + 4)
            .ok_or_else(|| self.err("bad unicode escape"))?;
        let n = u16::from_str_radix(h, 16)
            .ok()
            .ok_or_else(|| self.err("bad unicode escape"))?;
        self.i += 4;
        Ok(n)
    }
}
