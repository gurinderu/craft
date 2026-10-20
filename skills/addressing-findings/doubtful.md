# Doubtful findings — the reviewer chooses

A review run with `comment` posts only the findings in which there is no doubt — defects. A finding
whose rightness turns on what the PR author knows (intent, context, a deployment the diff does not
show) is not posted: the report lists it under **Doubtful — for the reviewer, not posted**, numbered,
each with why it is doubtful — not confirmed; raised by the `compat`, `intent` or `api-boundary`
lens; speaking of rollback, rollout, old replicas, migration or a breaking change; or its line
outside the lines the diff changed. Below the list the same findings stand as one JSON line. The
sorting changes nothing in the verdict.

## Steps

1. **Show the list to the human** as the report prints it, and ask in words, finding by finding:
   ask the author, post it as a defect, or do not post it — and, for "do not post", why. Never
   choose for him, never post a doubtful finding he did not choose, never skip the list because the
   verdict is green.
2. **Ask the author / post as a defect** — save the section's JSON line to a file in the session's
   temporary directory (never the repository), then, in the reviewed repository:

   ```bash
   pr=$(gh pr view --json number --jq .number)
   sha=$(gh pr view --json headRefOid --jq .headRefOid)
   node "<this skill's base directory>/../../lib/finding-post.mjs" --as question --commit "$sha" "$f" <n> \
     | gh api "repos/{owner}/{repo}/pulls/$pr/comments" --input -
   ```

   `--as question` for "ask the author", `--as defect` for "post as a defect"; `<n>` is the number
   in the list. The script builds the comment the engine would have posted — first line
   `[Severity] title`, the hidden lens and rule lines, for a question its ask and a hidden
   `<!-- craft-kind: question -->` line, the `<!-- craft-finding -->` marker last — so a later
   reply in that thread is tied to the finding (→ [pr-rejections.md](pr-rejections.md)). It
   refuses, naming why, a number not in the list, a finding without `file:line`, a commit that is
   no sha. **Never post a finding by hand**: a comment without the marker ties nothing.
3. **Do not post** — the human's "no" is a disposition, and it is written at once, without asking
   whether to, with the `craft:memory` skill, one line per write
   (`memory backend: <X> — recorded <kind> <id> (<title>)`, or `memory: no backend available — <why>; not recorded`):
   - "false", "by design", "accepted as it stands" → `record-decision`: title = the finding's
     title as listed, scope = its file, body = his reason, author = him, commit = `git rev-parse
     HEAD`, line = its line, lens = its `source`, toolRule = its `toolRule` when not empty,
     links = the PR;
   - a reason that is a stance of the whole project ("we do not support rollback") →
     `record-rule`, with his word that it is a stance, exactly as in "A stance is a project rule"
     of this skill; the finding at hand still gets its decision;
   - "later" → `record-question` with `deferred: true`, as a deferral in this skill.
4. **Count the choice** — after each chosen finding is posted or dropped, append the choice to the
   review run's own record, in the reviewed repository (no network; the newest review record of the
   project that lists doubtful findings, unless `--record <file>` names one):

   ```bash
   node "<this skill's base directory>/../../lib/craft-log-run.mjs" sorting-choice --n <n> --choice <question|defect|dropped>
   ```

   It prints the finding it recorded against — check it is the one chosen. A failure is named in
   one line and changes nothing else.
5. **The author's answer on a question** decides the finding, and is read by the thread rules of
   [pr-rejections.md](pr-rejections.md): a reply opening with a rejection phrase, from the PR
   author or a maintainer, becomes a decision through `pr-rejections.mjs`; "will fix" or a fix
   makes it a defect to work in the loop; "later" from the author becomes a `record-question`
   with `deferred: true`; a silent or resolved thread records nothing.

A finding nobody ruled on is never written to memory: only the human's or the author's word is.
