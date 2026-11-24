//! The list saved whole, or, when it cannot be, a note and lenses told so.

use super::{keep, prepare};
use crate::consumers::order::PER_SYMBOL;
use crate::consumers::{Consumers, Listed, Site, lens_block};

#[test]
fn a_list_that_cannot_be_saved_leaves_a_note_no_path_and_says_so_to_the_lenses() {
    let t = tempfile::tempdir().unwrap();
    let missing = t.path().join("no-such-dir");
    let sites = (1..=u32::try_from(PER_SYMBOL).unwrap() + 2)
        .map(|line| Site {
            file: "src/use.rs".into(),
            line,
            text: "f()".into(),
            from: vec!["name search".into()],
            kind: String::new(),
        })
        .collect();
    let full = Consumers {
        sources: vec!["name search".into()],
        symbols: vec![Listed {
            name: "f".into(),
            file: "src/lib.rs".into(),
            line: 1,
            sites,
        }],
        ..Consumers::default()
    };
    let (lens, note) = keep(&missing, full);
    let note = note.expect("no note of the failed write");
    assert!(
        note.starts_with("the consumers list could not be written: "),
        "{note}"
    );
    assert!(lens.file.is_empty(), "{}", lens.file);
    let block = lens_block(&lens).unwrap();
    assert!(
        block.contains("; 2 more cut by the budget (the whole list could not be saved)"),
        "{block}"
    );
}

#[test]
fn a_list_whose_thread_panicked_is_kept_as_failed_saying_it_stopped() {
    let t = tempfile::tempdir().unwrap();
    let built = std::thread::spawn(|| -> Consumers { std::panic::panic_any("boom") }).join();
    let (lens, note) = prepare(t.path(), built);
    assert_eq!(note, None);
    assert_eq!(lens.failed, "the consumers list stopped unexpectedly");
    assert!(t.path().join(crate::consumers::FILE).exists());
}
