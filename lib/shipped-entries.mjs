// The Node entry points that run in a consumer's repo, where no devDependency is installed: the run-record
// CLI the engines shell out to, the run-store reader run by hand, the PR-rejection reader addressing-findings
// runs, the recurrence reader it runs before asking about lessons (lib/recurring-findings.mjs), the
// request builder the review skills run to post a doubtful finding the reviewer chose (lib/finding-post.mjs), the
// SessionStart hook the harness runs from hooks/hooks.json (lib/session-start-hook.mjs), the hook at the moment of
// work it runs from the same file (lib/work-hook-entry.mjs), the hook before a push (lib/push-hook-entry.mjs), the
// reader a consumer's agent runs to take a failed bundled engine's position back to its source
// (lib/engine-source-map.mjs), the reader of a unitScope review's observed unit boundary run after it (lib/unit-boundary.mjs), and the OpenCode plugin. One list for the two configs that need it — knip.config.js (shipped entries of its production run)
// and .dependency-cruiser.mjs (what those entries may reach; realm @nick/craft, #145). The engines are not
// here: the Workflow tool loads them, and nothing they import remains in what it loads.
export const SHIPPED_NODE_ENTRIES = ['lib/craft-log-run.mjs', 'lib/analyze-runs.mjs', 'lib/pr-rejections.mjs', 'lib/recurring-findings.mjs', 'lib/finding-post.mjs', 'lib/session-start-hook.mjs', 'lib/work-hook-entry.mjs', 'lib/push-hook-entry.mjs', 'lib/engine-source-map.mjs', 'lib/unit-boundary.mjs', 'opencode/plugin/index.ts']
