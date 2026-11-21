// The Node entry points that run in a consumer's repo, where no devDependency is installed: the run-record
// CLI the engines shell out to, the run-store reader run by hand, the PR-rejection reader addressing-findings
// runs, the legacy adapter for the native recurrence reader (integrations/shared/recurring-findings.mjs), the
// request builder the review skills run to post a doubtful finding the reviewer chose (integrations/shared/finding-post.mjs), the
// reader a consumer's agent runs to take a failed bundled engine's position back to its source
// (integrations/shared/engine-source-map.mjs),
// the fetcher of the released craft CLI binary the review engine runs (integrations/shared/craft-bin.mjs), the pi extension pi loads from this package, whose tool runs the review (integrations/pi/pi-extension.mjs, #504), the discovery CLI
// `craft init` runs (integrations/shared/craft-externals.mjs, #435), the matcher of an external reviewer's PR findings against the run store, run by hand
// (integrations/shared/match-external-findings-cli.mjs; it shells out to `gh`, nothing else), and the OpenCode plugin with its TUI footer entry (plugin/tui/tui.mjs, #512). One list for the two configs that need it — integrations/shared/config/knip.config.js (shipped entries of its production run)
// and integrations/shared/config/.dependency-cruiser.mjs (what those entries may reach; realm @nick/craft, #145). The engines are not
// here: the Workflow tool loads them, and nothing they import remains in what it loads.
export const SHIPPED_NODE_ENTRIES = [
  'integrations/shared/craft-log-run.mjs',
  'integrations/shared/analyze-runs.mjs',
  'integrations/shared/pr-rejections.mjs',
  'integrations/shared/recurring-findings.mjs',
  'integrations/shared/finding-post.mjs',
  'integrations/shared/engine-source-map.mjs',
  'integrations/shared/craft-bin.mjs',
  'integrations/pi/pi-extension.mjs',
  'integrations/shared/craft-externals.mjs',
  'integrations/shared/match-external-findings-cli.mjs',
  'integrations/opencode/plugin/index.ts',
  'integrations/opencode/plugin/tui/tui.mjs',
]
