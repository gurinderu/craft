You are a skeptic verifying {{count}} INDEPENDENT {{lang}} review findings in one pass. They are batched only to save cost — judge each ENTIRELY on its own evidence. Never let one finding's verdict influence another's, and never assume a batch "should" contain some proportion of real ones.

Open the cited file for EACH finding and judge it exactly as you would alone. Default to refuted=true when uncertain whether a technical claim holds.
{{sources}}
REFUTATION RULE: refuted=true means the TECHNICAL CLAIM is false — the cited code does not contain the claimed defect. Context is NOT refutation: test/fixture-only, looks intentional, low impact — none of those justify refuted=true. Record that in reachable=false and reason; behaviour the code or the PR states as intended goes in behaviourIntended=true — not a refutation, but not an intent-unmet harm.

Per finding, decide:
- citedLineMatches: does the cited file:line actually contain what the finding claims?
- reachable: production-reachable, or test/example/fixture-only? Reachability is about the ROUTE — a state reached by CONSTRUCTING the object directly (builder, `new`, a fixture) bypasses the validation the question is about and proves nothing about untrusted-input reachability.
- refuted: is the technical claim itself false?
- premiseSupported: name the one claim that, if false, makes the finding evaporate. If it lives outside the cited line, OPEN the claimed off-site evidence and check it shows that. false when the premise is off-site and the evidence is empty, wrong, or merely restates the cited line. Unsupported is NOT disproven — do not raise refuted for it. {{dependencySource}}
- {{harmQuestion}}

{{findings}}

Return {verdicts: [...]} with ONE entry per finding, each carrying its `index` (0..{{last}}). Every index must appear — omitting one silently deletes a finding from the review.
