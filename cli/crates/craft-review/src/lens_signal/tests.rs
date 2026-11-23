//! Each lens signal fires on what it names and stays quiet on its look-alikes; a part's signals
//! are read from its source files' added lines, a real git change marks each track, and an
//! unreadable one leaves every signal unknown.

use super::{LARGE, mark, of_file, of_part};
use crate::design::mark_tests::change;
use crate::state::Track;

fn lines(text: &[&str]) -> Vec<(u32, String)> {
    (1u32..).zip(text.iter().map(|l| (*l).to_owned())).collect()
}

fn fires(line: &str) -> Vec<&'static str> {
    of_file(&lines(&[line]), false)
}

#[test]
fn unsafe_ffi_raw_pointers_and_transmute_fire_the_unsafe_signal() {
    for l in [
        "    unsafe { ptr.read() }",
        "extern \"C\" { fn abort(); }",
        "    let p: *const u8 = x;",
        "    let p = buf.as_mut_ptr();",
        "    let y: u32 = std::mem::transmute(x);",
        "use std::ffi::CStr;",
        "#[repr(C)]",
        "    let b = Box::from_raw(p);",
    ] {
        assert_eq!(fires(l), ["unsafe"], "{l}");
    }
    for l in ["    let s = safe_call(x);", "    let p = &x as &u8;"] {
        assert!(fires(l).is_empty(), "{l}");
    }
}

#[test]
fn money_words_fire_whole_never_inside_another_word() {
    for l in [
        "    let total_amount = 3;",
        "    fn priceOf(item: &Item) -> Decimal {",
        "    balance -= fee;",
        "use rust_decimal::Decimal;",
        "    let cents: i64 = 0;",
        "    CURRENCY_CODE,",
    ] {
        assert_eq!(fires(l), ["money"], "{l}");
    }
    for l in [
        "    let syntax = parse(x);",
        "    let balancer = lb();",
        "    let amountless = 1;",
        "    let feeling = 2;",
    ] {
        assert!(fires(l).is_empty(), "{l}");
    }
}

#[test]
fn threads_spawns_locks_atomics_and_channels_fire_the_concurrency_signal() {
    for l in [
        "    std::thread::spawn(move || run());",
        "    tokio::spawn(async move { x.await });",
        "    let m = Mutex::new(0);",
        "    let n = AtomicUsize::new(0);",
        "    let (tx, rx) = mpsc::channel();",
        "    await Promise.all(jobs);",
        "    go func() { done <- true }()",
    ] {
        assert_eq!(fires(l), ["concurrency"], "{l}");
    }
    for l in [
        "    a.cmp(&b) == std::cmp::Ordering::Less",
        "    let child = spawn(\"git\");",
    ] {
        assert!(fires(l).is_empty(), "{l}");
    }
}

#[test]
fn an_allocation_or_io_in_a_loop_body_fires_loop_io_only_near_its_opening() {
    let body = |gap: usize| {
        let mut text = vec!["    for x in xs {"];
        text.extend(std::iter::repeat_n("        step(x);", gap));
        text.push("        out.push(x.clone());");
        lines(&text)
    };
    assert_eq!(of_file(&body(0), false), ["loop-io"]);
    assert_eq!(of_file(&body(9), false), ["loop-io"], "line 11: its last");
    assert!(
        of_file(&body(10), false).is_empty(),
        "line 12: past the body"
    );
    let inline = lines(&["    while let Some(l) = r.read(&mut buf)? {"]);
    assert_eq!(
        of_file(&inline, false),
        ["loop-io"],
        "on the opening itself"
    );
    let before = lines(&["    let v = xs.clone();", "    for x in v {"]);
    assert!(of_file(&before, false).is_empty(), "above the loop");
    let no_loop = lines(&["    let v = xs.clone();", "    use(v);"]);
    assert!(of_file(&no_loop, false).is_empty());
    let each = lines(&["    xs.iter().for_each(|x| out.push(format!(\"{x}\")));"]);
    assert_eq!(of_file(&each, false), ["loop-io"]);
}

#[test]
fn a_new_file_or_one_with_many_added_lines_fires_new_or_large_file() {
    let small = lines(&["fn f() {}"]);
    assert_eq!(of_file(&small, true), ["new-or-large-file"]);
    assert!(of_file(&small, false).is_empty());
    let many: Vec<(u32, String)> = (1..=u32::try_from(LARGE).unwrap())
        .map(|n| (n, "    x();".to_owned()))
        .collect();
    assert_eq!(of_file(&many, false), ["new-or-large-file"]);
    assert!(of_file(&many[1..], false).is_empty(), "one line short");
}

#[test]
fn a_part_reads_its_source_files_once_each_signal_in_order_and_skips_data_and_new_tests() {
    let files: Vec<String> = [
        "src/pay.rs",
        "src/pool.rs",
        "content/rates.json",
        "tests/new_test.rs",
    ]
    .iter()
    .map(|f| (*f).to_owned())
    .collect();
    let added = |f: &str| match f {
        "src/pay.rs" => lines(&["let amount = 1;"]),
        "src/pool.rs" => lines(&["let m = Mutex::new(0);", "let price = 2;"]),
        "content/rates.json" => lines(&["{\"unsafe\": \"*mut \"}"]),
        _ => lines(&["fn t() {}"]),
    };
    let new = |f: &str| f == "tests/new_test.rs" || f == "content/rates.json";
    assert_eq!(of_part(&files, &added, &new), ["money", "concurrency"]);
    let big: Vec<(u32, String)> = (1..=u32::try_from(LARGE).unwrap())
        .map(|n| (n, "    check();".to_owned()))
        .collect();
    let tests_only = ["tests/big_test.rs".to_owned()];
    assert!(
        of_part(&tests_only, &|_| big.clone(), &|_| false).is_empty(),
        "a test file grown large maintains nothing"
    );
    let fresh = |f: &str| f == "src/pay.rs";
    assert_eq!(
        of_part(&files, &added, &fresh),
        ["money", "concurrency", "new-or-large-file"]
    );
}

#[test]
fn a_real_change_marks_each_track_with_its_own_signals() {
    let t = tempfile::tempdir().unwrap();
    let diff = change(
        t.path(),
        &[("src/lib.rs", "fn a() {}\n"), ("web/app.ts", "export {}\n")],
        &[
            ("src/lib.rs", "fn a() {}\nunsafe fn b() {}\n"),
            ("web/app.ts", "export {}\nconst price = 1;\n"),
        ],
    );
    let mut tracks = vec![
        Track::new("rust", vec!["src/lib.rs".into()]),
        Track::new("general", vec!["web/app.ts".into()]),
    ];
    assert_eq!(mark(t.path(), &diff, &mut tracks), None);
    assert_eq!(
        tracks[0].signals.as_deref(),
        Some(&["unsafe".to_owned()][..])
    );
    assert_eq!(
        tracks[1].signals.as_deref(),
        Some(&["money".to_owned()][..])
    );
}

#[test]
fn a_change_that_cannot_be_read_leaves_every_signal_unknown_and_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let diff = crate::git::Diff {
        base: "origin/main".into(),
        merge_base: "origin/main".into(),
        head: "HEAD".into(),
        dirty: false,
        worktree: String::new(),
        files: vec!["src/lib.rs".into()],
        stat: String::new(),
        log: String::new(),
    };
    let mut tracks = vec![Track::new("rust", vec!["src/lib.rs".into()])];
    let note = mark(dir.path(), &diff, &mut tracks).unwrap();
    assert!(note.contains("lens signals could not be read"), "{note}");
    assert_eq!(tracks[0].signals, None);
}
