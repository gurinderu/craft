You are scouting a {{lang}} diff to plan an elastic review. Use shell + read only — do NOT review yet.{{scope}}

Diff base: {{base}}. Consider only this profile's files ({{globs}}).
1. Inspect `git diff --stat {{statRange}} -- {{globs}}`. Set sizeBucket:
   small = a few files / < ~80 changed lines; large = many files / > ~400 lines or a public-API-heavy change; medium otherwise.
2. lenses: choose from {{lenses}}.
   - small: only the touched categories (minimum 2; always include the dominant category, and include '{{safetyLens}}' unless the diff clearly touches nothing related to {{securityHints}}).
   - medium: the categories plausibly in play.
   - large: all of them, EXCEPT {{conditionalLenses}} — the
     engine adds those itself off a code signal in the diff, so picking one here only pays for an
     agent the signal did not ask for. Do not count them toward your choices.
   {{scoutRules}}{{strict}}
3. isLibrary: {{isLibrary}}
4. securitySensitive: true if the diff touches {{securityHints}}.
5. intent: {{intent}}
6. churn: list up to 5 files in the diff that git shows as frequently changed (`git log --oneline -n 50 -- <file> | wc -l` is a rough proxy). May be empty.
7. surfaces: classify what the diff TOUCHES so the engine can skip a whole-repo lens whose defect class this diff cannot exhibit. Answer CONSERVATIVELY — if unsure, OMIT the field (or the individual key), or set it true; NEVER guess false. A false you are not sure of silences a lens.
   - crossBoundarySymbol: does the diff change the signature/shape of an exported/`pub` symbol that unchanged code depends on?
   - wireForm: does it change a contract that a party running ANOTHER version reads, calls or deploys against — a CRD schema or API version list, a serde type, an HTTP/OpenAPI shape, a protocol, a CLI flag / exit code / output format, a config key, an env var, a Helm value, a default, a renamed exported name?
   - invariantType: does it change a type that carries an invariant other code relies on?
8. {{repoRulesStep}}
