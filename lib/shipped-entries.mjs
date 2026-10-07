// The Node entry points that run in a consumer's repo, where no devDependency is installed: the run-record
// CLI the engines shell out to, the run-store reader run by hand, the PR-rejection reader addressing-findings
// runs, the recurrence reader it runs before asking about lessons (lib/recurring-findings.mjs), and the
// OpenCode plugin. One list for the two configs that need it — knip.config.js (shipped
// entries of its production run) and
// .dependency-cruiser.mjs (what those entries may reach; realm @nick/craft, #145). The engines are not
// here: the Workflow tool loads them, and they import nothing.
export const SHIPPED_NODE_ENTRIES = ['lib/craft-log-run.mjs', 'lib/analyze-runs.mjs', 'lib/pr-rejections.mjs', 'lib/recurring-findings.mjs', 'opencode/plugin/index.ts']
