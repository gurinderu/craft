# The author's rejections, from the PR's threads

Run at the start of the fix loop (step 0, before recall) and again before every re-review
(step 7). It turns what was already said on the PR — a reply opening with "not a bug", "by
design" … — into `memory` `record-decision`s, so the next review sets those findings aside and the
next triage sifts them out instead of raising them again. It reads; it never posts or resolves
anything.

## The rule — conservative on purpose

A thread yields a decision **only** when all of these hold:

1. **Its first comment is a finding** — of one of two kinds:
   - **A craft finding**: the body the review engine posts — first line `[Severity] title`, last
     line the `<!-- craft-finding -->` marker — **whose author is a maintainer**: the first
     comment's `authorAssociation` is `OWNER`, `MEMBER` or `COLLABORATOR`. craft posts under the
     `gh` account of the human running it, who maintains the repo; anyone else — the PR author
     included — can paste the marker, so a marked comment from any other association is a forged
     finding: named with why and counted, never recorded.
   - **Another reviewer's remark**: a comment without the marker — a person's, or their own
     tool's — from anyone. Its first line of text (heading and emphasis marks dropped, cut at a
     word past 120 characters) stands for the title. The reply rule is narrower here (rule 3): only
     an owner, member or collaborator settles such a remark — a PR author without that association
     never does, not even when the remark came from another login, since one outsider can hold two
     accounts and silence a remark for the whole project. A remark nobody rejected is not listed.
2. **Its last word is a reply that rejects the finding**: it **opens** with `not a bug`, `not an
   issue`, `by design`, `won't fix` / `wontfix` / `will not fix`, `works as intended` / `working as
   intended` / `as intended`, `intentional` or `false positive` (optionally after `this is` /
   `it's` / `that's`) — case-insensitive; the reply is the reason, verbatim. A rejection followed
   by any later comment, a phrase mid-sentence ("this was not a bug before the refactor, fixed"),
   or "fixed in …" is not a rejection. **No reply is no rejection** — a thread resolved silently
   may have been fixed outside the hunk.
3. **The replier may reject**: in a craft-finding thread, the PR author, or GitHub's
   `authorAssociation` of the reply is `OWNER`, `MEMBER` or `COLLABORATOR`. craft posts its comments
   under your own `gh` account, so in a self-review loop the poster is the PR author and their own
   reply counts. In another reviewer's thread, only that association counts: the PR author's reply
   is recorded only when they are an owner, member or collaborator. Anyone else's rejection is not
   recorded; the command names each and counts them.
4. **It can be anchored**: a path and the commit the finding was posted on.

Every craft-finding thread that does not qualify is listed with why, and every other reviewer's
thread whose rejection is not recorded; nothing is guessed.

## Steps

Run it; no `gh`, `gh` unauthenticated, or no PR for the branch makes it exit 2 naming why → skip,
and say so in one line (`PR rejections: skipped — <why>`):

```bash
sh "<this skill's base directory>/../../integrations/shared/craft-cli.sh" pr rejections
```

`--pr <number>` and `--repo <owner>/<name>` name the PR and repository when the checked-out
branch's are not the ones. The command asks `gh` for the PR, then for every page of its review
threads (`gh api graphql --paginate --slurp`: the PR's author, each thread's path, lines and first
50 comments with author, `authorAssociation`, body, URL, date and commit); `--threads <file | ->`
reads a saved answer of that query instead.

The command prints `{ decisions, skipped }`. Each decision is already a `memory` record —
`id`, `kind: decision`, `title` (the finding's, or the remark's first line), `body` (the reason), `scope` (the path), `date`,
`author` (who rejected), `commit` (the commit the thread was on), `line` (the thread's line on that
commit, when it has one), `lens` (the lens that raised the finding, when its comment names it), `toolRule` (the gate tool's own rule the finding
fired, when its comment names it),
`links` (the rejecting comment, then the finding comment). After a squash merge that commit is gone from the base branch: a later
review names such a decision under **Prior decisions not applied** and raises the finding normally
— re-record it against a current commit if it still holds. (The PR's base commit is not recorded
instead: the PR itself changed the file, so a scope check against it would always read "changed".) **`record-decision` each one as it is**, at once and without asking (→ SKILL.md, "Project
memory": one line per write naming the backend); the id makes a second run update rather than
duplicate. Report the count recorded and every `skipped` line. Exit 2 means the threads
could not be read (no PR, `gh` failing, an answer of another shape) — say so and record nothing.

**Bounds — the command refuses, never truncates:** more than 500 threads → the rest are named as
unread; a thread with more than 50 comments → skipped (its last word is unknown); a title over 200
or a reason over 1200 chars → skipped, to be recorded by hand (summarise the reason, link the
thread).
