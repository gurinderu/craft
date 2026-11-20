use std::collections::BTreeMap;

use super::{holds_sql, in_changed_lines, mark};
use crate::gate::lines::Lines;
use crate::state::Track;

#[test]
fn a_query_call_or_a_literal_opening_with_a_statement_holds_sql() {
    for l in [
        r#"    let rows = sqlx::query("select 1").fetch_all(&pool).await?;"#,
        r#"    let u = query_as!(User, "SELECT id FROM users WHERE id = $1", id)"#,
        r#"    client.query("SELECT id, name FROM users WHERE id = $1", &[&id]).await?;"#,
        r#"    diesel::sql_query("UPDATE t SET a = 1").execute(conn)?;"#,
        r##"    let q = r#"INSERT INTO jobs (id) VALUES ($1)"#;"##,
        r#"    cur.execute(f"delete from sessions where user_id = {uid}")"#,
        r"    const q = `with recent as (select * from t) select * from recent`;",
        "        SELECT a.id, b.name",
        "    'update accounts set balance = balance - 1 where id = %s'",
    ] {
        assert!(holds_sql(l), "{l}");
    }
}

#[test]
fn prose_identifiers_and_lone_keywords_hold_none() {
    for l in [
        r#"    println!("Select a file to open");"#,
        r#"    log::info!("update the cache before {x}");"#,
        r#"    let op = "delete";"#,
        r#"    let kw = "WITH";"#,
        r#"    let s = "SELECTION: done";"#,
        "    let selected = update(x);",
        "    // update: the cache is warm",
        "    /// Selects the first row.",
        r"    msg = 'insert the card'",
        "UPDATE = 1",
        "    SELECT = 'select'",
        r#"    println!("Select a file from the list");"#,
        r#"    println!("select one item from the menu, then update its set of tags");"#,
        r#"    let m = "delete from the cache";"#,
    ] {
        assert!(!holds_sql(l), "{l}");
    }
}

#[test]
fn only_an_added_line_of_the_profiles_files_counts() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("src")).unwrap();
    std::fs::write(
        dir.path().join("src/db.rs"),
        "fn f() {}\nlet q = \"SELECT id FROM t\";\nfn g() {}\n",
    )
    .unwrap();
    let ranges = |r: (u32, u32)| Lines::of(BTreeMap::from([("src/db.rs".to_owned(), vec![r])]));
    let files = ["src/db.rs".to_owned()];
    assert!(in_changed_lines(dir.path(), &ranges((2, 2)), &files));
    assert!(
        !in_changed_lines(dir.path(), &ranges((3, 3)), &files),
        "the query line is unchanged"
    );
    assert!(
        !in_changed_lines(dir.path(), &ranges((2, 2)), &["other.rs".to_owned()]),
        "another profile's file"
    );
    let gone = Lines::of(BTreeMap::from([("src/gone.rs".to_owned(), vec![(1, 1)])]));
    assert!(!in_changed_lines(
        dir.path(),
        &gone,
        &["src/gone.rs".to_owned()]
    ));
}

#[test]
fn a_change_that_cannot_be_read_marks_none_and_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let mut tracks = vec![Track::new("rust", vec!["src/db.rs".into()])];
    let note = mark(dir.path(), "origin/main", &mut tracks).unwrap();
    assert!(
        note.contains("embedded-SQL signal could not be read"),
        "{note}"
    );
    assert!(!tracks[0].embedded_sql);
}
