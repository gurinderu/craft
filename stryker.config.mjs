// Mutation testing (realm @nick/craft, #146): which lib/ logic the unit tests actually pin. Run weekly by
// .github/workflows/mutation.yml, never per PR and never as a gate. Dev tooling only, never shipped (#124).
// Run: `npm run test:mutation`, or narrow with `-- --mutate lib/x.mjs`.
import fs from 'node:fs'
import { parseFloor } from './lib/mutation-floor.mjs'

// The floor below which the run fails and what it is measured over: committed, and neither may fall —
// `break` only rises, `mutate` only widens; lib/check-mutation-floor.mjs also fails this config when its
// `mutate` or `thresholds.break` stops being the file's, or when it sets `ignorePatterns` or `files`:
// Stryker drops the files they match before `mutate` applies.
const floor = parseFloor(fs.readFileSync(new URL('./lib/mutation-floor.json', import.meta.url), 'utf8'))

export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.config.mjs', related: true },
  coverageAnalysis: 'perTest',
  // Source modules only: tests, and the test-only engine harness with its sandbox globals, are not the subject.
  mutate: floor.mutate,
  // In place, not in a sandbox copy: Stryker never copies a node_modules into its sandbox, and the
  // tsc-backed tests read opencode/plugin/node_modules — in a sandbox they skip, and the modules they
  // cover read as uncovered. The originals are restored when the run ends; a killed run can leave
  // instrumented files in lib/, which `git status` shows and a checkout of lib/ restores.
  inPlace: true,
  // A static mutant (a module-level constant, evaluated once on import) cannot be attributed to a test,
  // so each one reruns the whole suite: when measured they were a small share of the mutants, estimated to
  // cost about as much as all the others together and to push CI's run past its timeout (the dated counts
  // are the realm's). Ignored, they are reported as such — status `Ignored`, reason "Static mutant", in
  // reports/mutation/mutation.json, which is where to count them — and left out of the score.
  ignoreStatic: true,
  // The score was 72.6% when the floor was set at 70 (static mutants ignored). Below `break` the run exits
  // non-zero, which turns the weekly job red and opens an issue — a visible drop, not a blocked merge: the
  // job is no PR check. `high` follows a floor raised past it, since Stryker refuses `high` below `low`.
  thresholds: { high: Math.max(80, floor.break), low: floor.break, break: floor.break },
  reporters: ['clear-text', 'progress-append-only', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  incrementalFile: 'reports/mutation/stryker-incremental.json',
  tempDirName: '.stryker-tmp',
}
