//! Each lens signal fires on what it names and stays quiet on its look-alikes; a part's signals
//! are read from its source files' hunks, context and removals included; a real git change marks
//! each track; and what cannot be read leaves the signals unknown, never empty.

use super::hunks::FileChange;
use super::{BRANCH_MIN, LARGE, bounded, mark, of_file, of_part};
use crate::design::mark_tests::change;
use crate::state::Track;

fn lines(text: &[&str]) -> Vec<(u32, String)> {
    (1u32..).zip(text.iter().map(|l| (*l).to_owned())).collect()
}

fn fires(line: &str) -> Vec<&'static str> {
    of_file(&lines(&[line]), 1, false, 0)
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
        "    ledger.credit(account, charge_total);",
        "    fn debit(&mut self, cost: u64) {",
        "    let sats = to_btc(gwei);",
        "    if paid { withdraw(subtotal - discount) }",
        "    let USDAmount = bill(payer, payee);",
        "    let GBPValue = x;",
        "    let rateInUSD = x;",
        "    let v2Amount = x;",
        "    settle(revenue, salary, gbp, jpy, eth, usdc);",
        "    let x = transferred + invoiced + priced;",
    ] {
        assert_eq!(fires(l), ["money"], "{l}");
    }
    for l in [
        "    let syntax = parse(x);",
        "    let balancer = lb();",
        "    let amountless = 1;",
        "    let feeling = 2;",
        "    let weighted = paint();",
        "    let USDCASE = 1;",
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
    assert_eq!(of_file(&body(0), 0, false, 0), ["loop-io"]);
    assert_eq!(
        of_file(&body(39), 0, false, 0),
        ["loop-io"],
        "line 41: its last"
    );
    assert!(
        of_file(&body(40), 0, false, 0).is_empty(),
        "line 42: past the body"
    );
    let inline = lines(&["    while let Some(l) = r.read(&mut buf)? {"]);
    assert_eq!(
        of_file(&inline, 0, false, 0),
        ["loop-io"],
        "on the opening itself"
    );
    let before = lines(&["    let v = xs.clone();", "    for x in v {"]);
    assert!(of_file(&before, 0, false, 0).is_empty(), "above the loop");
    let no_loop = lines(&["    let v = xs.clone();", "    use(v);"]);
    assert!(of_file(&no_loop, 0, false, 0).is_empty());
    let each = lines(&["    xs.iter().for_each(|x| out.push(format!(\"{x}\")));"]);
    assert_eq!(of_file(&each, 0, false, 0), ["loop-io"]);
}

#[test]
fn an_allocation_in_an_iterator_chain_fires_loop_io_without_a_loop_keyword() {
    for l in [
        "    let v: Vec<_> = xs.iter().map(|x| x.clone()).collect();",
        "    let n = ys.into_iter().filter(|y| y.keep).map(|y| y.to_string()).count();",
        "    for_each(&mut zs.iter_mut(), |z| z.push(z.clone()));",
        "    arr.forEach(x => out.push(format!(\"{x}\")));",
    ] {
        assert_eq!(fires(l), ["loop-io"], "{l}");
    }
    // A map/filter/collect with no iteration starter is not a loop.
    let none = lines(&["    let v = opt.map(|x| x + 1);"]);
    assert!(of_file(&none, 0, false, 0).is_empty());
}

#[test]
fn a_branch_is_an_if_else_match_for_while_or_loop_at_a_statement_start() {
    for l in [
        "    if a {",
        "    if (a) {",
        "    } else if b {",
        "    } else {",
        "    match x {",
        "    for x in xs {",
        "    while let Some(v) = it.next() {",
        "    loop {",
    ] {
        assert!(super::words::is_branch(l), "{l}");
    }
    for l in [
        "    let ifx = 1;",
        "    // if a comment",
        "    elsewhere(x);",
        "    let v = x.clone();",
        "    use_loop(x);",
    ] {
        assert!(!super::words::is_branch(l), "{l}");
    }
}

#[test]
fn a_new_file_or_one_with_many_added_lines_or_branches_fires_new_or_large_file() {
    let small = lines(&["fn f() {}"]);
    assert_eq!(of_file(&small, 1, true, 0), ["new-or-large-file"]);
    assert!(of_file(&small, 1, false, 0).is_empty());
    assert_eq!(of_file(&small, LARGE, false, 0), ["new-or-large-file"]);
    assert!(
        of_file(&small, LARGE - 1, false, 0).is_empty(),
        "one line short"
    );
    assert_eq!(
        of_file(&small, 1, false, BRANCH_MIN),
        ["new-or-large-file"],
        "a small change with enough new branches is maintainable too"
    );
    assert!(
        of_file(&small, 1, false, BRANCH_MIN - 1).is_empty(),
        "one branch short"
    );
}

fn known(text: &[&str], added: usize, new: bool) -> FileChange {
    FileChange {
        new,
        lines: Some(lines(text)),
        added,
        branches: 0,
    }
}

#[test]
fn a_part_reads_its_source_files_each_signal_once_in_order_and_skips_data_and_tests_growth() {
    let files: Vec<String> = [
        "src/pay.rs",
        "src/pool.rs",
        "content/rates.json",
        "tests/new_test.rs",
    ]
    .iter()
    .map(|f| (*f).to_owned())
    .collect();
    let changes = |fresh: &'static str| {
        move |f: &str| match f {
            "src/pay.rs" => Some(known(&["let amount = 1;"], 1, f == fresh)),
            "src/pool.rs" => Some(known(
                &[
                    "for x in xs {",
                    "    out.push(x.clone());",
                    "let price = 2;",
                ],
                3,
                false,
            )),
            "tests/new_test.rs" => Some(known(&["fn t() {}"], LARGE, true)),
            _ => None,
        }
    };
    assert_eq!(
        of_part(&files, &changes("")),
        Some(vec!["money".to_owned(), "loop-io".to_owned()]),
        "a data file is never asked for; a test file grown new and large maintains nothing"
    );
    assert_eq!(
        of_part(&files, &changes("src/pay.rs")).unwrap(),
        ["money", "loop-io", "new-or-large-file"]
    );
}

#[test]
fn a_source_file_with_no_text_or_missing_from_the_diff_leaves_its_part_unknown() {
    let files = ["src/a.rs".to_owned(), "src/blob.rs".to_owned()];
    let binary = |f: &str| {
        Some(if f == "src/blob.rs" {
            FileChange::default()
        } else {
            known(&["let x = 1;"], 1, false)
        })
    };
    assert_eq!(
        of_part(&files, &binary),
        None,
        "a binary file shows no text"
    );
    let missing = |f: &str| (f == "src/a.rs").then(|| known(&["x"], 1, false));
    assert_eq!(
        of_part(&files, &missing),
        None,
        "a file the diff does not show"
    );
    assert_eq!(
        of_part(&files, &|_| Some(known(&["x"], 1, false))),
        Some(Vec::new()),
        "read and quiet: known to be none"
    );
}

#[test]
fn a_real_change_marks_each_track_from_its_context_and_removals() {
    let t = tempfile::tempdir().unwrap();
    let looped = "fn a(xs: &[u8]) {\n    for x in xs {\n        let v = x.clone();\n        use_it(v);\n    }\n}\n";
    let guarded = "export function f(n: number) {\n  if (balance < 0) {\n    throw new Error();\n  }\n  return n;\n}\n";
    let diff = change(
        t.path(),
        &[("src/lib.rs", looped), ("web/app.ts", guarded)],
        &[
            (
                "src/lib.rs",
                "fn a(xs: &[u8]) {\n    for x in xs {\n        let v = x.clone();\n        use_it(v, 1);\n    }\n}\n",
            ),
            (
                "web/app.ts",
                "export function f(n: number) {\n  return n;\n}\n",
            ),
        ],
    );
    let mut tracks = vec![
        Track::new("rust", vec!["src/lib.rs".into()]),
        Track::new("general", vec!["web/app.ts".into()]),
    ];
    assert_eq!(mark(t.path(), &diff, &mut tracks), None);
    assert_eq!(
        tracks[0].signals.as_deref(),
        Some(&["loop-io".to_owned()][..]),
        "an edit inside an existing loop that allocates: the loop and the clone are context"
    );
    assert_eq!(
        tracks[1].signals.as_deref(),
        Some(&["money".to_owned()][..]),
        "a removed balance guard: no added or context line names money"
    );
}

#[test]
fn signals_start_unknown_and_a_change_that_cannot_be_read_leaves_them_unknown() {
    assert_eq!(Track::new("rust", vec!["src/lib.rs".into()]).signals, None);
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
    tracks[0].signals = Some(Vec::new());
    let note = mark(dir.path(), &diff, &mut tracks).unwrap();
    assert!(note.contains("lens signals could not be read"), "{note}");
    assert_eq!(tracks[0].signals, None);
}

#[test]
fn a_binary_source_file_in_a_real_change_leaves_its_part_unknown() {
    let t = tempfile::tempdir().unwrap();
    let diff = change(
        t.path(),
        &[("src/lib.rs", "fn a() {}\n")],
        &[("src/lib.rs", "fn a() {}\n\0\u{1}binary\n")],
    );
    let mut tracks = vec![Track::new("rust", vec!["src/lib.rs".into()])];
    assert_eq!(mark(t.path(), &diff, &mut tracks), None);
    assert_eq!(tracks[0].signals, None);
}

#[test]
fn a_diff_past_the_bound_is_not_read() {
    assert_eq!(bounded("abcd".into(), 4), Ok("abcd".to_owned()));
    assert_eq!(
        bounded("abcde".into(), 4),
        Err("its diff is over 4 bytes".to_owned())
    );
}
