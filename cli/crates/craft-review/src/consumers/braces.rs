//! The structure of Rust source per line — its brackets and `;` — outside strings, character
//! literals and comments, so an item's span is read by its braces, not its indentation.

/// Where a line's scan stands: in code, a string, a raw string with this many `#`, or a block
/// comment.
#[derive(Clone, Copy)]
enum In {
    Code,
    Str,
    Raw(usize),
    Block,
}

/// The brackets and `;` of each of `lines`, in order.
pub(super) fn structure(lines: &[&str]) -> Vec<Vec<u8>> {
    let mut state = In::Code;
    lines
        .iter()
        .map(|l| {
            let mut out = Vec::new();
            let b = l.as_bytes();
            let mut i = 0;
            while i < b.len() {
                (state, i) = match state {
                    In::Code => code(b, i, &mut out),
                    In::Str => string(b, i),
                    In::Raw(h) => raw(b, i, h),
                    In::Block => block(b, i),
                };
            }
            out
        })
        .collect()
}

fn ident(c: Option<&u8>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

/// The `#` count and the index past the opening quote of a raw string starting at `i` (its `r`).
fn raw_open(b: &[u8], i: usize) -> Option<(usize, usize)> {
    let before = i.checked_sub(1).and_then(|p| b.get(p));
    let prefixed = before == Some(&b'b') && !ident(i.checked_sub(2).and_then(|p| b.get(p)));
    if ident(before) && !prefixed {
        return None;
    }
    let hashes = b.get(i + 1..)?.iter().take_while(|c| **c == b'#').count();
    (b.get(i + 1 + hashes) == Some(&b'"')).then_some((hashes, i + 2 + hashes))
}

/// The index past a character literal starting at `i`, or `None` for a lifetime.
fn char_end(b: &[u8], i: usize) -> Option<usize> {
    if b.get(i + 1) == Some(&b'\\') {
        let close = b.get(i + 2..)?.iter().skip(1).position(|c| *c == b'\'')?;
        return Some(i + 4 + close);
    }
    (b.get(i + 2) == Some(&b'\'')).then_some(i + 3)
}

fn code(b: &[u8], i: usize, out: &mut Vec<u8>) -> (In, usize) {
    let c = b.get(i).copied().unwrap_or_default();
    let next = b.get(i + 1).copied();
    match c {
        b'/' if next == Some(b'/') => (In::Code, b.len()),
        b'/' if next == Some(b'*') => (In::Block, i + 2),
        b'"' => (In::Str, i + 1),
        b'r' => raw_open(b, i).map_or((In::Code, i + 1), |(h, at)| (In::Raw(h), at)),
        b'\'' => (In::Code, char_end(b, i).unwrap_or(i + 1)),
        b'{' | b'}' | b'(' | b')' | b'[' | b']' | b';' => {
            out.push(c);
            (In::Code, i + 1)
        }
        _ => (In::Code, i + 1),
    }
}

fn string(b: &[u8], mut i: usize) -> (In, usize) {
    while let Some(c) = b.get(i) {
        match c {
            b'\\' => i += 2,
            b'"' => return (In::Code, i + 1),
            _ => i += 1,
        }
    }
    (In::Str, i)
}

fn raw(b: &[u8], i: usize, hashes: usize) -> (In, usize) {
    let closes = |j: usize| {
        b.get(j) == Some(&b'"')
            && b.get(j + 1..j + 1 + hashes)
                .is_some_and(|h| h.iter().all(|c| *c == b'#'))
    };
    (i..b.len())
        .find(|&j| closes(j))
        .map_or((In::Raw(hashes), b.len()), |j| (In::Code, j + 1 + hashes))
}

fn block(b: &[u8], i: usize) -> (In, usize) {
    (i..b.len())
        .find(|&j| b.get(j..j + 2) == Some(b"*/"))
        .map_or((In::Block, b.len()), |j| (In::Code, j + 2))
}

/// The last line (0-based) of the item declared at `d`: where its body's braces close, or the
/// `;` that ends it outside any bracket; `None` when the text ends first.
pub(super) fn item_end(st: &[Vec<u8>], d: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut body = false;
    for (n, line) in st.iter().enumerate().skip(d) {
        for &c in line {
            if ends(c, &mut depth, &mut body) {
                return Some(n);
            }
        }
    }
    None
}

/// Takes one structural character; whether it ends the item.
fn ends(c: u8, depth: &mut i32, body: &mut bool) -> bool {
    match c {
        b'{' | b'(' | b'[' => {
            *body |= c == b'{' && *depth == 0;
            *depth += 1;
            false
        }
        b'}' | b')' | b']' => {
            *depth -= 1;
            *depth < 0 || (*depth == 0 && *body)
        }
        _ => *depth == 0,
    }
}
