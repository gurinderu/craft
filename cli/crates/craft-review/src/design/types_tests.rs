use super::types::declared;

#[test]
fn public_types_read_in_each_language_that_spells_them() {
    let one = |ext: &str, l: &str| -> Vec<String> {
        declared(ext, &[(1, l.to_owned())])
            .into_iter()
            .map(|(_, t)| t)
            .collect()
    };
    for (ext, line, name) in [
        ("rs", "pub enum State {", "State"),
        ("rs", "pub trait Store: Send {", "Store"),
        ("ts", "export interface Plan {", "Plan"),
        ("ts", "export type Id = string;", "Id"),
        ("js", "export default class Engine {", "Engine"),
        ("java", "public final class Ledger {", "Ledger"),
        ("cs", "public record Entry(int id) {}", "Entry"),
        ("go", "type Client struct {", "Client"),
        ("go", "type Handler func(int)", "Handler"),
        ("py", "class Parser:", "Parser"),
    ] {
        assert_eq!(one(ext, line), [name], "{ext}: {line}");
    }
    for (ext, line) in [
        ("rs", "pub(crate) struct Inner;"),
        ("ts", "export enum Mode {}"),
        ("ts", "export const x = 1"),
        ("go", "type client struct {"),
        ("py", "class _Hidden:"),
        ("py", "    class Nested:"),
        ("rs", "class Parser:"),
        ("md", "pub struct Fake"),
    ] {
        assert!(one(ext, line).is_empty(), "{ext}: {line}");
    }
    let group = [
        (3, "type (".to_owned()),
        (4, "\tLedger struct{}".to_owned()),
        (5, "\tid int".to_owned()),
        (6, ")".to_owned()),
        (7, "\tAfter struct{}".to_owned()),
    ];
    assert_eq!(
        declared("go", &group),
        [(4, "Ledger".to_owned())],
        "a grouped block, read to its close"
    );
}
