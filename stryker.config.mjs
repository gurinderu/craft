// Mutation testing (realm @nick/craft, #146): which lib/ logic the unit tests actually pin. Run weekly by
// .github/workflows/mutation.yml, never per PR and never as a gate. Dev tooling only, never shipped (#124).
// Run: `npm run test:mutation`, or narrow with `-- --mutate lib/x.mjs`.
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
  // A static mutant (a module-level constant, evaluated once on import) cannot be attributed to a test,
  // so each one reruns the whole suite (about a minute): 464 of 10492 mutants, estimated to cost about as
  // much as the other 10028 together and to push CI's run past its timeout. Ignored, they are reported as
  // such and left out of the score.
  ignoreStatic: true,
  // The score was 72.6% when this was set (static mutants ignored). Below `break` the run exits non-zero,
  // which turns the weekly job red — a visible drop, not a blocked merge: the job is no PR check.
  thresholds: { high: 80, low: 70, break: 60 },
  reporters: ['clear-text', 'progress-append-only', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  incrementalFile: 'reports/mutation/stryker-incremental.json',
  tempDirName: '.stryker-tmp',
}
