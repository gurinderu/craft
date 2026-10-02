import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import { assertLintPrerequisites } from './lib/lint-prerequisites.mjs'

// Lint scope: the .mjs files under lib/ and opencode/plugin/, and opencode/plugin/*.ts.
//   - workflows/*.js are NOT linted as files and cannot be: they carry top-level export + await + return
//     and only parse inside the Workflow sandbox wrapper — the same reason `node --check` cannot
//     read them. `node lib/check-workflows.mjs` compiles them, and `npm run check:types:workflows`
//     type-checks them wrapped as the sandbox runs them; those are their gates.
//   - opencode/plugin/*.ts are type-checked by `npm run check:types` (tsc, opencode/plugin/tsconfig.json);
//     here they get the TypeScript parser and the type-aware rules below.
//
// Type-aware rules (typescript-eslint, devDependency only; realm @nick/craft, #137): each file is linted
// against the program its own type check builds — lib/tsconfig.json or opencode/plugin/tsconfig.json — so a
// rule sees the same types tsc does (JSDoc types in .mjs, though not a JSDoc cast: the parser drops its
// parentheses). typescript-eslint loads `typescript` from the root node_modules, hence the root
// devDependency pinned to opencode/plugin's version (lib/typescript-pin.test.mjs fails when they part).
// Only the rules of recommended-type-checked that report nothing on today's tree are on, so the gate stays
// zero-warning; the rules left off and what they report are on #137.
// Fail closed: a program missing a declared package still builds, its imports read as `any` and the rules
// go quiet, so loading this config throws unless both installs are whole (lib/lint-prerequisites.mjs).
assertLintPrerequisites(import.meta.dirname)

const typeAware = {
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/no-array-delete': 'error',
  '@typescript-eslint/no-duplicate-type-constituents': 'error',
  '@typescript-eslint/no-for-in-array': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/no-redundant-type-constituents': 'error',
  '@typescript-eslint/no-unnecessary-type-assertion': 'error',
  '@typescript-eslint/no-unsafe-enum-comparison': 'error',
  '@typescript-eslint/no-unsafe-unary-minus': 'error',
  '@typescript-eslint/prefer-promise-reject-errors': 'error',
  '@typescript-eslint/restrict-plus-operands': 'error',
}

export default [
  {
    ignores: [
      '**/node_modules/**',
      'workflows/**',
      'opencode/plugin/node_modules/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['lib/**/*.mjs', 'opencode/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        AbortController: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        Buffer: 'readonly',
        structuredClone: 'readonly',
        globalThis: 'readonly',
      },
    },
    rules: {
      // `x != null` is the deliberate idiom for "neither null nor undefined"; `!==` would
      // narrow it and let undefined through. Everything else compares strictly.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // The TypeScript parser and plugin for every linted file; core rules tsc already enforces are off for .ts.
  { ...tseslint.configs.base, files: ['lib/**/*.mjs', 'opencode/plugin/*.mjs', 'opencode/plugin/*.ts'] },
  { ...tseslint.configs.eslintRecommended, files: ['opencode/plugin/*.ts'] },
  // Core no-unused-vars reads a function type's parameter names as unused bindings; tsc's
  // noUnusedLocals/noUnusedParameters (opencode/plugin/tsconfig.json) already hold the real ones.
  { files: ['opencode/plugin/*.ts'], rules: { 'no-unused-vars': 'off' } },
  {
    files: ['lib/**/*.mjs'],
    languageOptions: { parserOptions: { project: ['./lib/tsconfig.json'], tsconfigRootDir: import.meta.dirname } },
    rules: typeAware,
  },
  {
    files: ['opencode/plugin/*.mjs', 'opencode/plugin/*.ts'],
    languageOptions: { parserOptions: { project: ['./opencode/plugin/tsconfig.json'], tsconfigRootDir: import.meta.dirname } },
    rules: typeAware,
  },
]
