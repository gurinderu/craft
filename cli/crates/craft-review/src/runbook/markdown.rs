//! A Markdown file's shell blocks and its numbered steps' inline code, as `CommonMark` reads them
//! (`pulldown-cmark`): a fenced block nested in a list item, at any indent, is a block; an
//! indented code block is not a fence. Each is placed by its line in the file.

use std::ops::Range;

use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};

/// The info strings of a fenced block that holds shell; an empty one counts too.
const SHELLS: &[&str] = &["sh", "bash", "shell", "console", "zsh", "shell-session"];
/// Of them, those whose `# ` opens a root prompt rather than a comment.
const SESSIONS: &[&str] = &["console", "shell-session"];

/// A fenced shell block: the line of its opening fence, the line its text starts on, its text with
/// the list's indent taken off, and whether `# ` is a root prompt in it.
pub(super) struct ShellBlock {
    pub opener: u32,
    pub first: u32,
    pub text: String,
    pub root_prompt: bool,
}

/// What [`walk`] finds: the shell blocks, and each numbered step's inline code with its line.
#[derive(Default)]
pub(super) struct Walked {
    pub blocks: Vec<ShellBlock>,
    pub codes: Vec<(u32, String)>,
}

/// The shell kind of a fenced block's info string: `Some(root_prompt)` for a shell, `None` else.
fn shell(info: &str) -> Option<bool> {
    let word = info.trim().split([' ', '{', ',']).next().unwrap_or("");
    let word = word.to_ascii_lowercase();
    (word.is_empty() || SHELLS.contains(&word.as_str())).then(|| SESSIONS.contains(&word.as_str()))
}

struct Walker {
    starts: Vec<usize>,
    /// Whether each open list, innermost last, is numbered.
    lists: Vec<bool>,
    open: Option<ShellBlock>,
    out: Walked,
}

impl Walker {
    /// The 1-based line holding byte `at`.
    fn line(&self, at: usize) -> u32 {
        let n = self.starts.partition_point(|s| *s <= at);
        u32::try_from(n).unwrap_or(u32::MAX)
    }

    fn on(&mut self, ev: Event<'_>, at: Range<usize>) {
        match ev {
            Event::Start(Tag::List(first)) => self.lists.push(first.is_some()),
            Event::End(TagEnd::List(_)) => {
                self.lists.pop();
            }
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info))) => {
                let opener = self.line(at.start);
                self.open = shell(&info).map(|root_prompt| ShellBlock {
                    opener,
                    first: opener + 1,
                    text: String::new(),
                    root_prompt,
                });
            }
            Event::Text(t) => self.text_in_block(&t, at.start),
            Event::End(TagEnd::CodeBlock) => self.out.blocks.extend(self.open.take()),
            Event::Code(c) if self.lists.last() == Some(&true) => {
                let line = self.line(at.start);
                self.out.codes.push((line, c.to_string()));
            }
            Event::Start(_)
            | Event::End(_)
            | Event::Code(_)
            | Event::InlineMath(_)
            | Event::DisplayMath(_)
            | Event::Html(_)
            | Event::InlineHtml(_)
            | Event::FootnoteReference(_)
            | Event::SoftBreak
            | Event::HardBreak
            | Event::Rule
            | Event::TaskListMarker(_) => {}
        }
    }

    fn text_in_block(&mut self, t: &str, at: usize) {
        let line = self.line(at);
        if let Some(b) = self.open.as_mut() {
            if b.text.is_empty() {
                b.first = line;
            }
            b.text.push_str(t);
        }
    }
}

/// The shell blocks and numbered steps' inline code of Markdown `text`.
pub(super) fn walk(text: &str) -> Walked {
    let starts = std::iter::once(0)
        .chain(text.match_indices('\n').map(|(i, _)| i + 1))
        .collect();
    let mut w = Walker {
        starts,
        lists: Vec::new(),
        open: None,
        out: Walked::default(),
    };
    for (ev, at) in Parser::new_ext(text, Options::empty()).into_offset_iter() {
        w.on(ev, at);
    }
    w.out
}
