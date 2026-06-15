# GitHub loop

Reading PR review comments (step 1) and closing the threads after the fix lands (step 8). All
outward writes (replies, resolution) happen **only after explicit user approval** — prepare
drafts, show them, wait for "ok".

## Gather PR comments (step 1)

```bash
# resolve the repo
gh repo view --json owner,name
# all review (inline) comments on the PR, paginated
gh api repos/{owner}/{repo}/pulls/<PR>/comments --paginate
```

Each item → one finding (→ [schema.md](schema.md), "Per-source mapping"). Key fields per comment:
`path`, `line`/`original_line`, `body`, `id`, `in_reply_to_id`, and the thread's resolved state.
Skip outdated/resolved threads.

## Close the loop (step 8)

After the fix is committed and re-review is green:

1. For each addressed thread, draft a reply: **what was fixed** + the **commit sha**, or **why it
   was rejected** (from the ledger reason).
2. Show all drafts to the user. **Do not post anything until the user explicitly approves.**
3. On approval, post each reply and resolve its thread:

```bash
# reply to a review comment thread
gh api repos/{owner}/{repo}/pulls/<PR>/comments \
  --method POST -f body="<reply>" -F in_reply_to=<comment_id>

# resolve the thread (GraphQL — needs the review thread node id, not the REST comment id)
gh api graphql -f query='
  mutation($id: ID!) {
    resolveReviewThread(input: {threadId: $id}) { thread { isResolved } }
  }' -f id=<thread_node_id>
```

Map each reply back to its thread via the `thread_id` carried on the finding through the fix.
