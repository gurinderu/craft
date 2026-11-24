use super::{Heredoc, Opened, scan};

fn doc(delimiter: &str) -> Heredoc {
    Heredoc {
        delimiter: delimiter.to_owned(),
        strip_tabs: false,
    }
}

fn opened(quote: Option<char>, heredocs: &[&str]) -> Opened {
    Opened {
        quote,
        heredocs: heredocs.iter().map(|d| doc(d)).collect(),
    }
}

#[test]
fn a_here_document_s_delimiter_is_read_in_each_spelling() {
    for (line, want) in [
        ("psql <<EOF", "EOF"),
        ("psql<<EOF", "EOF"),
        ("kubectl apply -f - <<'EOF'", "EOF"),
        ("cat <<\"END\" | kubectl apply -f -", "END"),
        ("psql <<E\\OF", "EOF"),
    ] {
        assert_eq!(scan(line, None), opened(None, &[want]), "{line}");
    }
    assert_eq!(scan("a <<A; b <<B", None), opened(None, &["A", "B"]));
}

#[test]
fn a_here_string_a_quoted_or_commented_angle_and_a_bare_one_open_nothing() {
    for line in [
        "psql <<< 'select 1'",
        "echo '<<EOF'",
        "echo \"<<EOF\"",
        "echo x # <<EOF",
        "echo \\<<EOF",
        "cat <<",
        "kubectl get pods",
    ] {
        assert_eq!(scan(line, None), Opened::default(), "{line}");
    }
    // A `#` inside a word opens no comment.
    assert_eq!(scan("echo a#b <<EOF", None), opened(None, &["EOF"]));
}

#[test]
fn a_quote_left_open_is_carried_to_the_next_line_and_closed_there() {
    assert_eq!(scan("ssh host 'set -e", None), opened(Some('\''), &[]));
    assert_eq!(scan("psql -c \"DELETE", None), opened(Some('"'), &[]));
    assert_eq!(
        scan("DELETE FROM users;", Some('\'')),
        opened(Some('\''), &[])
    );
    assert_eq!(scan("systemctl restart x'", Some('\'')), Opened::default());
    // In double quotes a `\"` is no close; in single quotes a `\` escapes nothing.
    assert_eq!(scan("a \\\" b", Some('"')), opened(Some('"'), &[]));
    assert_eq!(scan("a \\' b", Some('\'')), Opened::default());
    assert_eq!(scan("echo it\\'s", None), Opened::default());
}

#[test]
fn a_dash_strips_tabs_only_and_a_plain_body_closes_on_its_exact_delimiter() {
    let dashed = scan("ssh h bash <<-  SQL", None);
    let want = Heredoc {
        delimiter: "SQL".into(),
        strip_tabs: true,
    };
    assert_eq!(
        dashed,
        Opened {
            quote: None,
            heredocs: vec![want.clone()]
        }
    );
    assert!(want.closed_by("\t\tSQL"));
    assert!(!want.closed_by("  SQL"), "spaces are not stripped");
    let plain = doc("EOF");
    assert!(plain.closed_by("EOF"));
    for line in ["  EOF", "\tEOF", "EOF ", "EOFX"] {
        assert!(!plain.closed_by(line), "{line:?}");
    }
}

#[test]
fn an_arithmetic_shift_opens_no_here_document() {
    for line in [
        "echo $((1<<2))",
        "x=$(( y << 3 ))",
        "((x<<=1))",
        "let x=y<<1",
        "let 'x = y << 1'",
    ] {
        assert_eq!(scan(line, None), Opened::default(), "{line}");
    }
    // Past the arithmetic, a here-document still opens.
    assert_eq!(
        scan("n=$((1<<2)); psql <<EOF", None),
        opened(None, &["EOF"])
    );
}
