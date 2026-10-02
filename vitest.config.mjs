import { defineConfig } from 'vitest/config'

// The unit tests run on Vitest, a devDependency only: nothing shipped imports it (realm `@nick/craft`, #140, #124).
export default defineConfig({
  test: {
    // Explicit, not Vitest's default `**/*.test.*`: agent worktrees under .claude/worktrees/ carry whole
    // copies of lib/ and would be collected a second time from the main checkout.
    include: ['lib/**/*.test.mjs', 'opencode/**/*.test.mjs'],
    exclude: ['**/node_modules/**'],
    // No per-test deadline (the previous runner had none): engine-harness and tsc-backed tests run for seconds.
    testTimeout: 0,
    hookTimeout: 0,
  },
})
