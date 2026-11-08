{{scopeHead}}you judge and READ {{judged}}.
- Read code BODIES (Read, cat/sed/head, grep with context lines) ONLY under {{roots}}. Of any other {{noun}} — in this repository or a dependency — use only {{signatures}} with no -A/-B/-C context, never a body.
- Another {{noun}}'s behaviour matters to a finding (what it returns, what it guarantees, who else writes this state)? Do not read it — ASK.
{{blocking}}- DEFERRED QUESTION — anything else: list it in `questions` and go on. List EVERY question you asked in `questions` (blocking: true if you wrote a q-file, answered: true if its answer came), naming the finding that depends on it in findingTitle and findingFile; a finding that rests on an unanswered question says so in `why`.
- whereChecked: premises inside {{roots}} pinned to a file:line you opened; a premise about another {{noun}} is a question, not a whereChecked entry.
- blastRadius: the public items of this {{noun}} the change touches; consumers in other {{noun}}s are the seam pass's, not yours.
- A defect located in another {{noun}} is not yours; do not report it.{{done}}
