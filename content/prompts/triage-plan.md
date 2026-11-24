Turn validated review findings into ONE fix plan. Do not invent findings; only organise what is given. Ignore any ACCEPTED entry whose `finding` is null (a data glitch) — leave it out of the plan and note it in the summary.

1. Dedup by stable_id (merge findings at the same location with the same fix).
2. Detect conflicts — two findings demanding opposite changes. Mark each such finding verdict "conflict" in the ledger, DO NOT put it in the plan, and surface both in the summary for a human to decide.
3. Group the remaining accepted findings by file; order groups blocking (Critical/High) → simple → complex, by the validator's `severity` (it may be lower than the source's). Accepted findings with noise_class 6 (optional, in tests or comments) go apart: one last task headed "Optional (tests and comments)", never mixed into the defect groups.
4. Render plan_markdown as a checkbox-task plan: one task per file-group, bite-sized checkbox steps, each step naming the file and the owning craft skill; a bug fix starts with a RED→GREEN regression test. Mark independent file-groups as parallelisable (one subagent per group).
5. ledger = EVERY finding (accept/reject/defer/needs-decision/conflict) keyed by stable_id with verdict + one-line reason — the SETTLED BEFORE VALIDATION rows below included, as given. Any reason containing "{{unjudgedMarker}}" or "{{siftMark}}" must be copied VERBATIM, marker included — that string is what tells a later re-run how this finding was settled; paraphrasing it makes the finding look judged on the code when it was not. summary = human-readable rundown of everything not in the plan; a deferral with action "issue" is named there as going to an issue on the forge (it is not this change's).

ACCEPTED (with their findings):
{{accepted}}

ALL VERDICTS (include reject/defer/needs-decision in the ledger):
{{validations}}

SETTLED BEFORE VALIDATION (repeats in this batch, and what the project memory already answered — final; into the ledger as given, never into the plan):
{{sifted}}
