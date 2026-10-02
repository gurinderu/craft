// Mutation testing trial (realm @nick/craft, #146): which lib/ logic the unit tests actually pin.
// Dev tooling only, never shipped (#124). Run: `npm run test:mutation`, or narrow with `-- --mutate lib/x.mjs`.
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.config.mjs', related: true },
  coverageAnalysis: 'perTest',
  // Source modules only: tests, and the test-only engine harness with its sandbox globals, are not the subject.
  mutate: ['lib/**/*.mjs', '!lib/**/*.test.mjs', '!lib/engine-harness.mjs', '!lib/sandbox-globals.mjs'],
  // In place, not in a sandbox copy: Stryker never copies a node_modules into its sandbox, and the
  // tsc-backed tests read opencode/plugin/node_modules — in a sandbox they skip, and the modules they
  // cover read as uncovered. The originals are restored when the run ends; a killed run can leave
  // instrumented files in lib/, which `git status` shows and a checkout of lib/ restores.
  inPlace: true,
  reporters: ['clear-text', 'progress-append-only', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  incrementalFile: 'reports/mutation/stryker-incremental.json',
  tempDirName: '.stryker-tmp',
}
