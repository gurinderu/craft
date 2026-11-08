//! A parity file read into a [`Node`], its keys in the order the file holds them.

use std::fmt;

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::Value;

use super::ordered::Node;

impl<'de> Deserialize<'de> for Node {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(NodeVisitor)
    }
}

struct NodeVisitor;

impl<'de> Visitor<'de> for NodeVisitor {
    type Value = Node;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JSON")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Node, A::Error> {
        let mut kv = Vec::new();
        while let Some(entry) = m.next_entry::<String, Node>()? {
            kv.push(entry);
        }
        Ok(Node::Object(kv))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut s: A) -> Result<Node, A::Error> {
        let mut xs = Vec::new();
        while let Some(x) = s.next_element()? {
            xs.push(x);
        }
        Ok(Node::Array(xs))
    }

    fn visit_bool<E>(self, v: bool) -> Result<Node, E> {
        Ok(Node::Leaf(Value::Bool(v)))
    }

    fn visit_i64<E>(self, v: i64) -> Result<Node, E> {
        Ok(Node::Leaf(Value::from(v)))
    }

    fn visit_u64<E>(self, v: u64) -> Result<Node, E> {
        Ok(Node::Leaf(Value::from(v)))
    }

    fn visit_f64<E>(self, v: f64) -> Result<Node, E> {
        Ok(Node::Leaf(Value::from(v)))
    }

    fn visit_str<E>(self, v: &str) -> Result<Node, E> {
        Ok(Node::Leaf(Value::String(v.to_owned())))
    }

    fn visit_unit<E>(self) -> Result<Node, E> {
        Ok(Node::Leaf(Value::Null))
    }
}
