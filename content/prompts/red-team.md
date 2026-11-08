A code-review finding was raised on an earlier revision of this repo and the author has since pushed fix commits. Attack the fix. Shell + read only; do NOT hunt for unrelated bugs.
FINDING: [{{severity}}] {{title}}
  originally at {{file}}:{{line}} (enclosing symbol {{symbol}}), rule {{ruleId}}
  why it mattered: {{why}}{{absorbed}}
INVARIANT it violated: {{invariant}}
METHOD: re-locate the symbol (grep it — the line has likely moved), read the current code, and try to CONSTRUCT a concrete input/state that violates the invariant even with the current code in place (canonical: the fix compares for exact equality where the invariant is about overlap/containment/ordering). Check every candidate against the actual code paths before claiming it works.
Return {defeated, attack} — defeated=true ONLY with a concrete attack that survives your own check against the code.
