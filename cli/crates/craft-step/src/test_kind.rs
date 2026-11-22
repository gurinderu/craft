//! A kind of run that adds nothing but a `blocked` answer, for the crate's tests.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{Kind, Model, Task};

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Empty {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Plain {
    #[serde(rename = "plain")]
    Plain,
}

impl Kind for Plain {
    type Agent = String;
    type Marks = Empty;
    type Flags = Empty;

    fn tag(&self) -> &'static str {
        "plain"
    }

    fn blocked(_task: &Task<Self>, answer: &serde_json::Value) -> Option<String> {
        answer
            .get("blocked")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    }
}

pub fn task() -> Task<Plain> {
    let schema = json!({"type": "object", "required": ["ok"]});
    Task::new(
        "t".into(),
        "t".into(),
        "p".into(),
        Model::Haiku,
        schema,
        Plain::Plain,
    )
}
