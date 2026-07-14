# GitHub loop

Reading PR review comments (step 1) and closing the threads after the fix lands (step 8). All
outward writes (replies, resolution) happen **only after explicit user approval** — prepare
drafts, show them, wait for "ok".

## Gather PR comments (step 1)

Fetch **review threads via GraphQL**, not the REST comments endpoint. REST
(`/pulls/<PR>/comments`) returns every inline comment but **carries no `isResolved`/`isOutdated`
field** — so the "skip outdated/resolved" rule below can't be applied to it, and a `first:N` that
doesn't follow `pageInfo.hasNextPage` silently drops the newest threads (they sort last). GraphQL
gives the state and the thread node id (needed to resolve in step 8) in one place.

```bash
# resolve the repo
gh repo view --json owner,name

# all review threads, following pagination — DO NOT stop at the first page
gh api graphql --paginate -f query='
  query($owner:String!, $name:String!, $pr:Int!, $endCursor:String) {
    repository(owner:$owner, name:$name) {
      pullRequest(number:$pr) {
        reviewThreads(first:100, after:$endCursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id                       # thread node id — pass to resolveReviewThread in step 8
            isResolved
            isOutdated
            path
            line
            comments(first:1) { nodes { databaseId author { login } body } }
          }
        }
      }
    }
  }' -F owner={owner} -F name={name} -F pr=<PR>
```

Each thread → one finding (→ [schema.md](schema.md), "Per-source mapping"). Key fields per thread:
`path`, `line`, the first comment's `body` + `databaseId`, the thread `id`, `isResolved`,
`isOutdated`. **Skip threads where `isResolved` or `isOutdated` is true.**

`--paginate` on `gh api graphql` requires the `pageInfo { hasNextPage endCursor }` shape above and
a `$endCursor` variable — without it, only the first 100 threads are returned and the most recent
review comments go missing. REST `/pulls/<PR>/comments --paginate` remains a fallback when you only
need the raw comment bodies and resolution state is irrelevant.

## Close the loop (step 8)

After the fix is committed and re-review is green:

1. For each addressed thread, draft a reply: **what was fixed** + the **commit sha**, or **why it
   was rejected** (from the ledger reason).
2. Show all drafts to the user. **Do not post anything until the user explicitly approves.**
3. On approval, post each reply and resolve its thread:

```bash
# reply to a review comment thread — in_reply_to takes the first comment's databaseId
gh api repos/{owner}/{repo}/pulls/<PR>/comments \
  --method POST -f body="<reply>" -F in_reply_to=<comment_databaseId>

# resolve the thread (GraphQL — takes the review thread node id, not the comment databaseId)
gh api graphql -f query='
  mutation($id: ID!) {
    resolveReviewThread(input: {threadId: $id}) { thread { isResolved } }
  }' -f id=<thread_node_id>
```

Both ids come straight from the step-1 gather: `comment_databaseId` = `comments[0].databaseId`,
`thread_node_id` = the thread `id`. Carry the thread `id` on the finding as `thread_id` and map
each reply back through it — no separate lookup needed.
