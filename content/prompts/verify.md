{{head}}

FINDING: [{{severity}}] {{title}}
  at {{at}}
  why: {{why}}
  source: {{source}}{{rule}}
  off-site evidence claimed: {{evidence}}{{repoRule}}{{harm}}

MECHANICAL CHECK FIRST: if a tool can decide this finding (a clippy lint, statix/deadnix rule, semgrep rule, cargo-audit advisory — infer from source/ruleId/title), RUN it scoped to the cited file; its output overrides your judgement in BOTH directions: tool still reports it → refuted=false; tool demonstrably no longer reports it → refuted=true (quote the output in reason).{{gate}}{{toolFallback}}

REFUTATION RULE: refuted=true means the finding's TECHNICAL CLAIM is false — the cited code does not contain the claimed defect, or the deciding tool demonstrably no longer reports it. Context is NOT refutation: that the code is test/fixture/example-only, looks intentional, is unlikely to be built or run, or has low impact NEVER justifies refuted=true. Record that context in reachable=false and reason instead — severity is calibrated downstream. Behaviour the code or the PR states as intended goes in behaviourIntended=true: it does not refute the defect, but it is not an intent-unmet harm.

{{exclusions}}{{sources}}Open the cited file and check:
1. citedLineMatches: does {{at}} actually contain what the finding claims? (If the citation is wrong/hallucinated → citedLineMatches=false.)
2. reachable: is this code reachable in production, or is it test/example/fixture-only code? (Test-only → reachable=false. This does NOT refute the finding — it only calibrates severity downstream.) REACHABILITY IS ABOUT THE ROUTE, not just the destination: if the claim is "reachable from untrusted input", check that the ROUTE runs from the real entry point — the parser, the handler, the deserializer, the public API — on attacker-supplied data. Reaching the state by CONSTRUCTING the object directly (a builder, `new`, a test fixture, an internal constructor) bypasses exactly the validation the question is about, and proves nothing about untrusted-input reachability. That trap catches careful reviewers, so check it explicitly rather than assuming the route was the obvious one.
3. refuted: is the technical claim itself false? ({{refutedRule}})
4. premiseSupported: identify the finding's LOAD-BEARING premise — the one claim that, if false, makes the finding evaporate. If it lives outside the cited line (the dependency behaves this way, this is reachable from untrusted input, no caller guards it, the sibling does X), OPEN the `whereChecked` location and check it actually shows that. premiseSupported=false when the premise is off-site and `whereChecked` is empty, points somewhere that does not show it, or merely restates the cited line. premiseSupported=true when the finding is genuinely self-contained at the cited line, or the off-site evidence checks out. Do NOT set refuted=true just because a premise is uncited — unsupported is not disproven; that is what this field is for, and it demotes the finding downstream instead of killing it. {{dependencySource}}
5. {{harmQuestion}}

Return {refuted, citedLineMatches, reachable, premiseSupported, behaviourIntended, harmSupported, confirmedHarmLevel (a listed level or null), reason}.
