# Doubtful findings — the reviewer chooses

A review run with `comment` posts only the findings in which there is no doubt — defects. A finding
whose rightness turns on what the PR author knows (intent, context, a deployment the diff does not
show) is not posted: the report lists it under **Doubtful — for the reviewer, not posted**, numbered,
each with why it is doubtful — not confirmed; raised by the `compat`, `intent` or `api-boundary`
lens; a `design` question naming no harm; speaking of rollback, rollout, old replicas, migration or a breaking change; or its line
outside the lines the diff changed. The run's record keeps the same findings by the same numbers.
The sorting changes nothing in the verdict.

## Steps

1. **Show the list to the human** as the report prints it, and ask in words, finding by finding:
   ask the author, post it as a defect, or do not post it — and, for "do not post", why. Never
   choose for him, never post a doubtful finding he did not choose, never skip the list because the
   verdict is green.
2. **Ask the author / post as a defect** — in the reviewed repository, on the reviewed branch:

   ```bash
   sh "<this skill's base directory>/../../integrations/shared/craft-cli.sh" review post --n <n> --as question
   ```

   `--as question` for "ask the author", `--as defect` for "post as a defect"; `<n>` is the number
   in the list. The command reads the finding from the review run's own record (the newest
   review record of this repository carrying doubtful findings, refused when it is another
   branch's, not guessed past; `--record <file>` names another — **a retry always passes the
   `record` the first try printed or named**, so a newer review of the branch is not taken in its
   place) and posts it, through `gh`, on the PR that review read — never
   the PR of whatever is checked out now: the PR the run published on when its record names one
   (a `pr=<n>` review in a detached worktree; a different `--pr` is refused); else, for a review
   of a branch, the one open PR of this repository (never a fork's PR of a branch of the same
   name) whose head is that branch, or `--pr <number>` when that PR's head branch is the record's;
   else, for a detached-HEAD review that published nothing, `--pr <number>` of this repository.
   Always only on a same-repository PR that is open and whose head holds the reviewed commit (its
   head fetched from `origin` when missing, within a time limit), and never from a review of
   uncommitted work (as the review judged it, read from the run directory its record names — a
   run directory that is gone tells nothing, and nothing is posted).
   The comment is the one the engine would have posted — first line `[Severity] title`, the hidden
   lens and rule lines, for a question its ask and a hidden `<!-- craft-kind: question -->` line,
   the `<!-- craft-finding -->` marker last — so a later reply in that thread is tied to the
   finding (→ [pr-rejections.md](pr-rejections.md)). A finding on a changed line is anchored to it;
   one whose line is outside the diff, or a line GitHub refuses, becomes a file-level comment, since
   GitHub takes no line comment outside the diff — same marker, same thread reading. A comment
   already on the PR for that finding is not posted again — found before the PR's state and head
   are judged on the record's own PR (or on a closed PR of its branch, when none is open), so a
   retry records its choice even once the PR closed or its head moved; on a PR named with `--pr`
   a comment counts only once that PR's head holds the reviewed commit. It is posted on the reviewed commit the
   record names: when the PR's head moved since, only if the new commits leave its line alone; a
   record naming no reviewed commit posts nothing. It prints one JSON line — the PR, `posted`,
   `already`, `toFile`, `reason`, and `recorded`: the choice it wrote into the record (step 4 is
   done for it; `null` with a warning on stderr when that write failed). Exit 2 refuses what it
   cannot read or tell — no record, a number the record does not list, a finding without a file,
   no single open same-repository PR of the record's branch, a `--pr` of another branch, a PR
   whose head does not hold the reviewed commit, a fork's PR, a closed or merged PR, a record
   whose run directory cannot be read, a
   detached-HEAD record with neither a PR of its own nor `--pr`, no `gh` answer about the PR;
   exit 1 is the post failing (`gh` refusing it, the PR's head not fetched from `origin`, a moved
   head over its line, no reviewed commit, a review of uncommitted work), named in one line with
   the record to retry with — nothing posted. A file the PR does not touch takes no review
   comment at all: GitHub refuses it; say so to the human and leave that finding to a word with the
   author. **Never post a finding by hand**: a comment without the marker ties nothing.
3. **Do not post** — the human's "no" is a disposition, and it is written at once, without asking
   whether to, with the `craft:memory` skill, one line per write
   (`memory backend: <X> — recorded <kind> <id> (<title>)`, or `memory: no backend available — <why>; not recorded`):
   - "false", "by design", "accepted as it stands" → `record-decision`: title = the finding's
     title as listed, scope = its file, body = his reason, author = him, `decidedBy: "human"`,
     commit = `git rev-parse HEAD`, line = its line, lens = its `source`, toolRule = its `toolRule` when not empty,
     links = the PR;
   - a reason that is a stance of the whole project ("we do not support rollback") →
     `record-rule`, with his word that it is a stance, exactly as in "A stance is a project rule"
     of this skill; the finding at hand still gets its decision;
   - "later" → `record-question` with `deferred: true`, as a deferral in this skill.
4. **Count the choice** — `review post` records a posted one itself; after each finding dropped
   (or when its `recorded` is `null`), append the choice to the review run's own record, in the reviewed repository on the reviewed branch (no network; the newest
   review record of the project that lists doubtful findings; when that newest one is another
   branch's it is refused, and `--record <file>` must name the run meant):

   ```bash
   sh "<this skill's base directory>/../../integrations/shared/craft-cli.sh" runs sorting-choice --n <n> --choice <question|defect|dropped>
   ```

   It prints the finding it recorded against — check it is the one chosen. A failure is named in
   one line and changes nothing else.
5. **The author's answer on a question** decides the finding, and is read by the thread rules of
   [pr-rejections.md](pr-rejections.md): a reply opening with a rejection phrase, from the PR
   author or a maintainer, becomes a decision through `craft pr rejections`; "will fix" or a fix
   makes it a defect to work in the loop; "later" from the author becomes a `record-question`
   with `deferred: true`; a silent or resolved thread records nothing.

A finding nobody ruled on is never written to memory: only the human's or the author's word is.
