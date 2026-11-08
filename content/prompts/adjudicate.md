You are adjudicating whether a prior review finding is still present after a fix attempt. Load the {{rubricSkill}} skill for the rubric. Shell + read only; do NOT hunt for new bugs.
FINDING: [{{severity}}] {{title}}
  originally at {{file}}:{{line}} (enclosing symbol {{symbol}}), rule {{ruleId}}
  why it mattered: {{why}}{{absorbed}}
METHOD:
  1. State in ONE sentence the INVARIANT this finding violated — the property that must hold, not the literal repro (derive it from the why/title).
  2. Re-locate the symbol (grep it — the line has likely moved) and read the fix.
  3. Construct AT LEAST TWO concrete attacks: inputs/states that would violate the invariant while the current fix is in place (canonical: the fix compares for exact equality where the invariant is about overlap/containment/ordering). Check each against the actual code.
  4. Decide:
  - "resolved": every attack fails — the fix closes the CLASS, not just the described instance.
  - "still-open": the defect is still present OR one of your attacks succeeds (cite the current file:line; put the attack in `attack`).
  - "cannot-tell": you could NOT determine the answer — the file is gone or renamed, the symbol no longer exists, or you could not read enough of the code to judge. Say why in `note`. Use this rather than "resolved" whenever you are guessing: "resolved" means you checked and every attack failed, never "I could not find it".
  - "regressed": the site was changed but now has a DIFFERENT defect of the same kind (cite it).
Return {status, currentLine, note, invariant, attack}.
