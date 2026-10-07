# The author's rejections, from the PR's threads

Run at the start of the fix loop (step 0, before recall) and again before every re-review
(step 7). It turns what the author already said on the PR — "not a bug", "by design", a thread
resolved with the code untouched — into `memory` `record-decision`s, so the next review sets those
findings aside instead of raising them again. It reads; it never posts or resolves anything.

## The rule — conservative on purpose

A thread yields a decision **only** when all of these hold:

1. **Its first comment is a craft finding**: the body the review engine posts — first line
   `[Severity] title`, last line the `<!-- craft-finding -->` marker. A thread without the marker
   (a human's comment, another bot's, a craft comment from before the marker existed) is never
   recorded: it cannot be tied to a specific finding.
2. **Its last word rejects the finding**, from someone other than the account that posted it:
   - a reply that **opens** with `not a bug`, `not an issue`, `by design`, `won't fix` / `wontfix`
     / `will not fix`, `works as intended` / `working as intended` / `as intended`, `intentional`
     or `false positive` (optionally after `this is` / `it's` / `that's`) — case-insensitive; the
     reply is the reason, verbatim;
   - or **no reply at all**, the thread resolved by someone other than the poster and **not
     outdated** (the code at the finding is unchanged) — resolved without a change.
   A rejection followed by any later comment, a phrase mid-sentence ("this was not a bug before the
   refactor, fixed"), or "fixed in …" is not a rejection.
3. **It can be anchored**: a path and the commit the finding was posted on.

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
        reviewThreads(first:100, after:$endCursor) {
          pageInfo { hasNextPage endCursor }
          totalCount
          nodes {
            isResolved isOutdated path resolvedBy { login }
            comments(first:50) {
              totalCount
              nodes { author { login } body url createdAt originalCommit { oid } }
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
`author` (who rejected), `commit` (the commit the thread was on), `links` (the rejecting comment,
then the finding comment). **`record-decision` each one as it is**; the id makes a second run update
rather than duplicate. Report the count recorded and every `skipped` line. Exit 2 means the input
was unreadable — say so and record nothing.

**Bounds — the script refuses, never truncates:** more than 500 threads → the rest are named as
unread; a thread with more than 50 comments → skipped (its last word is unknown); a title over 200
or a reason over 1200 chars → skipped, to be recorded by hand (summarise the reason, link the
thread).
