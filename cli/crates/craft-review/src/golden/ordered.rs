//! A JSON tree that keeps its keys in the order the file holds them, written back as `JSON.stringify(v, null, 2)`
//! writes it, so a regenerated file differs from the committed one only where a value changed.

use serde_json::Value;

#[derive(Debug, Clone)]
pub(crate) enum Node {
    Object(Vec<(String, Node)>),
    Array(Vec<Node>),
    Leaf(Value),
}

impl Node {
    /// The node at `ptr`, a JSON pointer whose segments are object keys and array indices.
    pub(crate) fn at(&self, ptr: &str) -> Option<&Node> {
        segments(ptr).try_fold(self, |n, seg| match n {
            Node::Object(kv) => kv.iter().find(|(k, _)| *k == seg).map(|(_, v)| v),
            Node::Array(xs) => xs.get(seg.parse::<usize>().ok()?),
            Node::Leaf(_) => None,
        })
    }

    /// Writes `v` at `ptr`, the keys and elements both already hold kept in place; an object key the path or `v`
    /// names that is missing is added at the end.
    pub(crate) fn set(&mut self, ptr: &str, v: &Value) {
        let mut n = self;
        for seg in segments(ptr) {
            n = match n {
                Node::Object(kv) => {
                    let i = kv.iter().position(|(k, _)| *k == seg).unwrap_or_else(|| {
                        kv.push((seg.clone(), Node::Leaf(Value::Null)));
                        kv.len() - 1
                    });
                    &mut kv[i].1
                }
                Node::Array(xs) => {
                    let i: usize = seg
                        .parse()
                        .unwrap_or_else(|_| panic!("{ptr}: {seg} is not an index"));
                    xs.get_mut(i)
                        .unwrap_or_else(|| panic!("{ptr}: no element {i}"))
                }
                Node::Leaf(_) => panic!("{ptr}: {seg} under a scalar"),
            };
        }
        n.merge(v);
    }

    fn merge(&mut self, v: &Value) {
        match (&mut *self, v) {
            (Node::Object(kv), Value::Object(m)) => {
                kv.retain(|(k, _)| m.contains_key(k));
                for (k, x) in m {
                    match kv.iter_mut().find(|(have, _)| have == k) {
                        Some((_, n)) => n.merge(x),
                        None => kv.push((k.clone(), Node::from(x))),
                    }
                }
            }
            (Node::Array(xs), Value::Array(ys)) if xs.len() == ys.len() => {
                xs.iter_mut().zip(ys).for_each(|(n, y)| n.merge(y));
            }
            _ => *self = Node::from(v),
        }
    }

    pub(crate) fn to_value(&self) -> Value {
        match self {
            Node::Object(kv) => {
                Value::Object(kv.iter().map(|(k, v)| (k.clone(), v.to_value())).collect())
            }
            Node::Array(xs) => Value::Array(xs.iter().map(Node::to_value).collect()),
            Node::Leaf(v) => v.clone(),
        }
    }

    /// The text `JSON.stringify(self, null, 2)` gives.
    pub(crate) fn pretty(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, 0);
        out
    }

    fn write(&self, out: &mut String, depth: usize) {
        let pad = |d: usize| "  ".repeat(d);
        let quote = |s: &str| serde_json::to_string(s).expect("a string serializes");
        match self {
            Node::Object(kv) if !kv.is_empty() => {
                out.push_str("{\n");
                for (i, (k, v)) in kv.iter().enumerate() {
                    out.push_str(&format!("{}{}: ", pad(depth + 1), quote(k)));
                    v.write(out, depth + 1);
                    out.push_str(if i + 1 < kv.len() { ",\n" } else { "\n" });
                }
                out.push_str(&format!("{}}}", pad(depth)));
            }
            Node::Array(xs) if !xs.is_empty() => {
                out.push_str("[\n");
                for (i, v) in xs.iter().enumerate() {
                    out.push_str(&pad(depth + 1));
                    v.write(out, depth + 1);
                    out.push_str(if i + 1 < xs.len() { ",\n" } else { "\n" });
                }
                out.push_str(&format!("{}]", pad(depth)));
            }
            Node::Object(_) => out.push_str("{}"),
            Node::Array(_) => out.push_str("[]"),
            Node::Leaf(v) => out.push_str(&v.to_string()),
        }
    }
}

impl From<&Value> for Node {
    fn from(v: &Value) -> Self {
        match v {
            Value::Object(m) => {
                Node::Object(m.iter().map(|(k, x)| (k.clone(), Node::from(x))).collect())
            }
            Value::Array(xs) => Node::Array(xs.iter().map(Node::from).collect()),
            v @ (Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)) => {
                Node::Leaf(v.clone())
            }
        }
    }
}

fn segments(ptr: &str) -> impl Iterator<Item = String> + '_ {
    ptr.split('/')
        .skip(1)
        .map(|s| s.replace("~1", "/").replace("~0", "~"))
}

#[cfg(test)]
mod tests {
    use super::Node;
    use serde_json::json;

    #[test]
    fn a_file_reads_back_as_it_was_written_and_a_set_keeps_the_order() {
        let text = "{\n  \"z\": [\n    1,\n    \"a\\nb\"\n  ],\n  \"a\": {},\n  \"m\": {\n    \"y\": true,\n    \"b\": null\n  }\n}";
        let mut n: Node = serde_json::from_str(text).unwrap();
        assert_eq!(n.pretty(), text);
        n.set("/m", &json!({"b": 2, "y": true, "new": []}));
        n.set("/a/k~1v", &json!("x"));
        assert_eq!(n.at("/m/b").unwrap().to_value(), json!(2));
        assert!(
            n.pretty()
                .contains("\"y\": true,\n    \"b\": 2,\n    \"new\": []")
        );
        assert_eq!(n.at("/a").unwrap().to_value(), json!({"k/v": "x"}));
        assert!(n.at("/z/5").is_none());
    }
}
