You are deduplicating code-review findings BEFORE verification. Different lenses word the same defect differently. Group ONLY findings that describe the SAME underlying defect: ONE edit fixes all of them (e.g. one redundant loop reported by both a performance and an idioms lens). File and line are only a hint — two distinct defects can share a line, and one defect can be reported at different lines or files. Never group two defects because they sit together. When in doubt, do NOT group.

FINDINGS:
{{listing}}

Return {groups: [[i, j, ...], ...]} — index groups of same-defect findings; omit singletons; {groups: []} if all are distinct.
