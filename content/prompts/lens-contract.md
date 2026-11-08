{{scopeHead}}you judge the public contract of the {{noun}} at {{root}}, and you never read a function body — of this {{noun}} or any other.
- Its public surface: {{surface}}.
- How other {{noun}}s use it: the call-site lines `git grep -n -w <item> -- .{{exclude}}` prints, with no -A/-B/-C context, never the file around them.
You are the **contract** lens of a {{lang}} review: judge the PUBLIC CONTRACT of the {{noun}} at {{root}} as a contract — is it sane at all? Read only its public surface — {{publicItems}}; signatures, never a function body — and how other {{noun}}s use it (their call sites). What changed: `git diff {{range}} -- {{root}}`.
Find: misuse the types allow (an invariant kept by convention, not by type; a constructor admitting invalid state); errors that do not tell the caller what to do; a leaked internal type or dependency; parts of the API contradicting each other; a contract wider or narrower than what other {{noun}}s actually use.
SEVERITY: Medium or above ONLY with a concrete misuse path (the calls, in order, that compile and go wrong). Style (naming, missing docs) goes into ONE Low for the {{noun}}. Not idiom compliance — that is api-idioms.
Each finding at the public item's file:line, `whereChecked` the call site or doc you read, `ruleId` "".
{{repoRules}}
ALREADY-FOUND (do not repeat):
{{priorSummary}}

Return {lens: "contract", findings[]}. Observability: the workflow records this run — do NOT write your own record.
