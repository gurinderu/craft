# The author's rejections, from the PR's threads

Run at the start of the fix loop (step 0, before recall) and again before every re-review
(step 7). It turns what was already said on the PR — a reply opening with "not a bug", "by
design" … — into `memory` `record-decision`s, so the next review sets those findings aside instead
of raising them again. It reads; it never posts or resolves anything.

## The rule — conservative on purpose

A thread yields a decision **only** when all of these hold:

1. **Its first comment is a craft finding**: the body the review engine posts — first line
   `[Severity] title`, last line the `<!-- craft-finding -->` marker. A thread without the marker
   (a human's comment, another bot's, a craft comment from before the marker existed) is never
   recorded: it cannot be tied to a specific finding. **And its author is a maintainer**: the first
   comment's `authorAssociation` is `OWNER`, `MEMBER` or `COLLABORATOR`. craft posts under the `gh`
   account of the human running it, who maintains the repo; anyone else — the PR author included —
   can paste the marker, so a marked comment from any other association is a forged finding: named
   with why and counted, never recorded.
2. **Its last word is a reply that rejects the finding**: it **opens** with `not a bug`, `not an
   issue`, `by design`, `won't fix` / `wontfix` / `will not fix`, `works as intended` / `working as
   intended` / `as intended`, `intentional` or `false positive` (optionally after `this is` /
   `it's` / `that's`) — case-insensitive; the reply is the reason, verbatim. A rejection followed
   by any later comment, a phrase mid-sentence ("this was not a bug before the refactor, fixed"),
   or "fixed in …" is not a rejection. **No reply is no rejection** — a thread resolved silently
   may have been fixed outside the hunk.
3. **The replier may reject**: the PR author, or GitHub's `authorAssociation` of the reply is
   `OWNER`, `MEMBER` or `COLLABORATOR`. craft posts its comments under your own `gh` account, so in
   a self-review loop the poster is the PR author and their own reply counts. Anyone else's
   rejection is not recorded; the script names each and counts them.
4. **It can be anchored**: a path and the commit the finding was posted on.

Every craft-finding thread that does not qualify is listed with why; nothing is guessed.

## Steps

No `gh`, `gh` unauthenticated, or no PR for the branch → skip, and say so in one line
(`PR rejections: skipped — <why>`). Otherwise:

```bash
gh pr view --json number,url --jq '.number'        # the PR; none → skip
gh repo view --json owner,name --jq '.owner.login + " " + .name'
f=$(mktemp)                                        # the session's temp dir, never the repo
gh api graphql --paginate --slurp -f query='
  query($owner:String!, $name:String!, $pr:Int!, $endCursor:String) {
    repository(owner:$owner, name:$name) {
      pullRequest(number:$pr) {
        author { login }
        reviewThreads(first:100, after:$endCursor) {
          pageInfo { hasNextPage endCursor }
          totalCount
          nodes {
            path
            line
            originalLine
            comments(first:50) {
              totalCount
              nodes { author { login } authorAssociation body url createdAt originalCommit { oid } }
            }
          }
        }
      }
    }
  }' -F owner=<owner> -F name=<name> -F pr=<PR> > "$f"
node "<this skill's base directory>/../../lib/pr-rejections.mjs" "$f"
```

The script prints `{ decisions, skipped }`. Each decision is already a `memory` record —
`id`, `kind: decision`, `title` (the finding's), `body` (the reason), `scope` (the path), `date`,
`author` (who rejected), `commit` (the commit the thread was on), `line` (the thread's line on that
commit, when it has one), `lens` (the lens that raised the finding, when its comment names it),
`links` (the rejecting comment, then the finding comment). After a squash merge that commit is gone from the base branch: a later
review names such a decision under **Prior decisions not applied** and raises the finding normally
— re-record it against a current commit if it still holds. (The PR's base commit is not recorded
instead: the PR itself changed the file, so a scope check against it would always read "changed".) **`record-decision` each one as it is**, at once and without asking (→ SKILL.md, "Project
memory": one line per write naming the backend); the id makes a second run update rather than
duplicate. Report the count recorded and every `skipped` line. Exit 2 means the input
was unreadable — say so and record nothing.

**Bounds — the script refuses, never truncates:** more than 500 threads → the rest are named as
unread; a thread with more than 50 comments → skipped (its last word is unknown); a title over 200
or a reason over 1200 chars → skipped, to be recorded by hand (summarise the reason, link the
thread).
