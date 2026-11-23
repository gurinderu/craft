use super::{Opened, scan};

fn opened(quote: Option<char>, heredocs: &[&str]) -> Opened {
    Opened {
        quote,
        heredocs: heredocs.iter().map(|d| (*d).to_owned()).collect(),
    }
}

#[test]
fn a_here_document_s_delimiter_is_read_in_each_spelling() {
    for (line, want) in [
        ("psql <<EOF", "EOF"),
        ("psql<<EOF", "EOF"),
        ("kubectl apply -f - <<'EOF'", "EOF"),
        ("cat <<\"END\" | kubectl apply -f -", "END"),
        ("ssh h bash <<-  SQL", "SQL"),
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
