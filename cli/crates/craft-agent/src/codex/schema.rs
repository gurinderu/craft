//! A JSON Schema as `codex exec --output-schema` takes it. Codex sends the schema in the API's
//! strict mode, which refuses an object whose `required` leaves out one of its properties or that
//! does not forbid others (observed: codex-cli 0.167.0, a 400 `invalid_json_schema` naming the
//! missing key). So Codex gets a strict copy — every property required, each optional one
//! nullable, no other allowed — and the nulls the model wrote for the optional ones are dropped
//! from its answer, which then has the shape the original schema describes.

use serde_json::{Map, Value, json};

/// The strict copy of `schema`: every object's properties all required, each one left optional
/// made nullable, and no other property allowed; arrays' items and the alternatives of `anyOf`,
/// `oneOf` and `allOf` the same.
#[must_use]
pub fn strict(schema: &Value) -> Value {
    let Some(obj) = schema.as_object() else {
        return schema.clone();
    };
    let is_object = obj.get("type") == Some(&json!("object"))
        || obj.get("properties").is_some_and(Value::is_object);
    let mut s = if is_object {
        strict_object(obj)
    } else {
        obj.clone()
    };
    if let Some(items) = s.get_mut("items") {
        *items = strict(items);
    }
    for k in ["anyOf", "oneOf", "allOf"] {
        if let Some(Value::Array(alts)) = s.get_mut(k) {
            for alt in alts.iter_mut() {
                *alt = strict(alt);
            }
        }
    }
    Value::Object(s)
}

/// The names `required` lists.
fn required(s: &Map<String, Value>) -> Vec<&str> {
    s.get("required")
        .and_then(Value::as_array)
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// One object level made strict, its properties first.
fn strict_object(s: &Map<String, Value>) -> Map<String, Value> {
    let empty = Map::new();
    let props = s
        .get("properties")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let req = required(s);
    let properties: Map<String, Value> = props
        .iter()
        .map(|(k, v)| {
            let v = strict(v);
            let v = if req.contains(&k.as_str()) {
                v
            } else {
                nullable(v)
            };
            (k.clone(), v)
        })
        .collect();
    let mut out = s.clone();
    out.insert(
        "required".into(),
        Value::Array(props.keys().map(|k| json!(k)).collect()),
    );
    out.insert("properties".into(), Value::Object(properties));
    out.insert("additionalProperties".into(), json!(false));
    out
}

/// A schema that also takes null.
fn nullable(s: Value) -> Value {
    let Value::Object(mut o) = s else {
        return json!({"anyOf": [s, {"type": "null"}]});
    };
    match o.get("type").cloned() {
        Some(Value::String(t)) => {
            o.insert("type".into(), json!([t, "null"]));
            if let Some(Value::Array(e)) = o.get_mut("enum") {
                e.push(Value::Null);
            }
            Value::Object(o)
        }
        Some(Value::Array(mut ts)) => {
            if !ts.contains(&json!("null")) {
                ts.push(json!("null"));
                o.insert("type".into(), Value::Array(ts));
            }
            Value::Object(o)
        }
        _ => json!({"anyOf": [Value::Object(o), {"type": "null"}]}),
    }
}

/// `value` with each null dropped where `schema` (the original) leaves the property optional: what
/// the strict copy made the model write for a field it had nothing for.
#[must_use]
pub fn drop_optional_nulls(value: Value, schema: &Value) -> Value {
    let Some(s) = schema.as_object() else {
        return value;
    };
    match value {
        Value::Array(items) => {
            let item = s.get("items").unwrap_or(&Value::Null);
            Value::Array(
                items
                    .into_iter()
                    .map(|v| drop_optional_nulls(v, item))
                    .collect(),
            )
        }
        Value::Object(fields) => match s.get("properties").and_then(Value::as_object) {
            Some(props) => {
                let req = required(s);
                Value::Object(
                    fields
                        .into_iter()
                        .filter(|(k, v)| !v.is_null() || req.contains(&k.as_str()))
                        .map(|(k, v)| {
                            let sub = props.get(&k).unwrap_or(&Value::Null);
                            let v = drop_optional_nulls(v, sub);
                            (k, v)
                        })
                        .collect(),
                )
            }
            None => Value::Object(fields),
        },
        other @ (Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)) => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_strict_copy_requires_every_property_makes_the_optional_nullable_and_forbids_others() {
        let schema = json!({
            "type": "object", "required": ["a"],
            "properties": {
                "a": {"type": "string"},
                "b": {"type": "string", "enum": ["x"]},
                "c": {"type": "array", "items": {"type": "object", "properties": {"d": {"type": "integer"}}}},
                "e": {"type": ["string", "integer"]},
                "f": {"$ref": "#/x"},
            }
        });
        let got = strict(&schema);
        assert_eq!(got["required"], json!(["a", "b", "c", "e", "f"]));
        assert_eq!(got["additionalProperties"], json!(false));
        assert_eq!(got["properties"]["a"], json!({"type": "string"}));
        assert_eq!(
            got["properties"]["b"],
            json!({"type": ["string", "null"], "enum": ["x", null]})
        );
        assert_eq!(got["properties"]["c"]["type"], json!(["array", "null"]));
        assert_eq!(
            got["properties"]["c"]["items"],
            json!({"type": "object", "properties": {"d": {"type": ["integer", "null"]}}, "required": ["d"], "additionalProperties": false})
        );
        assert_eq!(
            got["properties"]["e"]["type"],
            json!(["string", "integer", "null"])
        );
        assert_eq!(
            got["properties"]["f"],
            json!({"anyOf": [{"$ref": "#/x"}, {"type": "null"}]})
        );
    }

    #[test]
    fn a_schema_strict_already_is_its_own_copy() {
        let schema = json!({"type": "object", "required": ["a"], "additionalProperties": false, "properties": {"a": {"type": "string"}}});
        assert_eq!(strict(&schema), schema);
    }

    #[test]
    fn the_nulls_of_optional_properties_are_dropped_a_required_null_kept() {
        let schema = json!({
            "type": "object", "required": ["a", "list"],
            "properties": {
                "a": {"type": ["string", "null"]}, "b": {"type": "string"},
                "list": {"type": "array", "items": {"type": "object", "required": [], "properties": {"x": {"type": "string"}}}},
            }
        });
        let answer = json!({"a": null, "b": null, "list": [{"x": null}, {"x": "y"}]});
        assert_eq!(
            drop_optional_nulls(answer, &schema),
            json!({"a": null, "list": [{}, {"x": "y"}]})
        );
    }
}
