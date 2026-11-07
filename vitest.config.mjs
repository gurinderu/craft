import { defineConfig } from 'vitest/config'

// The unit tests run on Vitest, a devDependency only: nothing shipped imports it (realm `@nick/craft`, #140, #124).
// A content/ prompt template (lib/content.mjs) is imported as its raw text, as the engine build's text loader inlines it.
const contentText = {
  name: 'craft-content-text',
  enforce: /** @type {const} */ ('pre'),
  /** @param {string} code @param {string} id */
  transform(code, id) {
    return id.endsWith('.md') ? { code: `export default ${JSON.stringify(code)}`, map: null } : null
  },
}

export default defineConfig({
  plugins: [contentText],
  test: {
    // Explicit, not Vitest's default `**/*.test.*`: agent worktrees under .claude/worktrees/ carry whole
    // copies of lib/ and would be collected a second time from the main checkout.
    include: ['lib/**/*.test.mjs', 'integrations/opencode/**/*.test.mjs'],
    exclude: ['**/node_modules/**'],
    // No per-test deadline (the previous runner had none): engine-harness and tsc-backed tests run for seconds.
    testTimeout: 0,
    hookTimeout: 0,
  },
})
