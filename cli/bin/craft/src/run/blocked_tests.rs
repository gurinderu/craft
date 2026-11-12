//! The could-not-look field through Codex's strict schema copy (realm @nick/craft, nodes #511,
//! #24): the copy makes every optional field required and nullable, so a healthy Codex agent must
//! write the field anyway — a false flag or nulls must validate and leave the task clean, and only
//! a literal `true` fail it.

use craft_agent::codex::schema::{drop_optional_nulls, strict};
use craft_review::{blocked, content};
use serde_json::{Value, json};

/// Whether `answer` matches `schema`.
fn valid(schema: &Value, answer: &Value) -> bool {
    jsonschema::validator_for(schema).unwrap().is_valid(answer)
}

#[test]
fn the_strict_copy_makes_the_field_required_and_nullable() {
    let copy = strict(&content::schema("findings").unwrap());
    assert!(
        copy["required"]
            .as_array()
            .unwrap()
            .contains(&json!("blocked"))
    );
    assert_eq!(
        copy["properties"]["blocked"]["type"],
        json!(["object", "null"])
    );
    assert_eq!(
        copy["properties"]["blocked"]["required"],
        json!(["couldNotLook", "what"])
    );
}

#[test]
fn a_healthy_codex_answer_through_the_strict_copy_validates_and_stays_clean() {
    let schema = content::schema("findings").unwrap();
    let copy = strict(&schema);
    for said in [
        json!(null),
        json!({"couldNotLook": false, "what": null}),
        json!({"couldNotLook": false, "what": "none"}),
        json!({"couldNotLook": false, "what": "N/A — nothing blocked"}),
    ] {
        let written = json!({"lens": "errors", "findings": [], "blocked": said});
        assert!(valid(&copy, &written), "the strict copy takes {written}");
        let answer = drop_optional_nulls(written, &schema);
        assert!(valid(&schema, &answer), "the original takes {answer}");
        assert_eq!(blocked::reason(&answer), None, "clean: {answer}");
    }
}

#[test]
fn a_codex_agent_that_could_not_look_still_fails() {
    let schema = content::schema("findings").unwrap();
    let copy = strict(&schema);
    for (what, want) in [
        (
            json!("bwrap: Operation not permitted"),
            "bwrap: Operation not permitted",
        ),
        (json!(null), "the agent said it could not look"),
    ] {
        let written = json!({"lens": "errors", "findings": [], "blocked": {"couldNotLook": true, "what": what}});
        assert!(valid(&copy, &written), "{written}");
        let answer = drop_optional_nulls(written, &schema);
        assert_eq!(blocked::reason(&answer).as_deref(), Some(want), "{answer}");
    }
}
