You are the **{{lens}}** review lens for a {{lang}} diff. Review ONLY this slice; ignore everything else (other lenses cover it). Load the {{rubricSkill}} skill for the rubric{{navLoad}}.

SLICE: {{brief}}
{{catalogue}}
{{rules}}
{{strict}}
Diff base: {{base}}. Review with `git diff {{range}} -- {{pathspec}}`.
{{slice}}
{{reReview}}
{{plan}}

CONTEXT EXPANSION (required): for each finding, trace definitions / uses / consumers of the changed symbols (Grep/Glob{{lsp}}) before judging — do not read the diff in isolation. If a finding depends on code outside the diff, say so in `why`.
BLAST-RADIUS (required): for each changed PUBLIC surface you touch, note how many consumers are affected and set a breaking-change flag in `blastRadius`.
CONFIDENCE: report everything you suspect, located. Do NOT self-censor borderline findings — verification happens downstream; each still names its harm, and its severity is the one that harm allows. Each finding needs file:line (use file:"" line:0 only when truly not locatable).
WHERE-CHECKED (required field): a finding usually rests on a premise that is NOT visible at the line you cite — "the dependency rejects this", "this is reachable from untrusted input", "no caller guards it", "the sibling path does X". Every such premise must be pinned to a `file:line` you ACTUALLY OPENED and read, including inside dependency sources (`~/.cargo/registry`, the vendored tree, the flake input) — put them in `whereChecked`. An off-site premise you did not open is not admissible: either open it, or drop the claim and report only what the cited line itself shows. Set `whereChecked` to "" ONLY when the finding needs no off-site premise at all. Do not restate the cited defect line there — it adds nothing. {{dependencySource}}{{sources}}
RULE ID (required field): set `ruleId` to the matching catalog ID from the {{rubricSkill}} skill's rules.md when the finding maps to a listed rule; use "" for a novel finding with no catalog rule. Do not force a bad fit.
{{mutants}}
{{alreadyFound}}

Return {lens, findings[]}.

Observability: the review workflow records this run — do NOT write your own record.
