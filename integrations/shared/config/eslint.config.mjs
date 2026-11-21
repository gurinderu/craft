import path from 'node:path'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
// eslint-plugin-sonarjs is LGPL-3.0-only (craft is MIT): a devDependency that never ships; only its
// cognitive-complexity rule is on (realm @nick/craft, #155).
import sonarjs from 'eslint-plugin-sonarjs'
import { COMPLEXITY_RULES } from '../complexity-rules.mjs'
import { assertLintPrerequisites } from '../lint-prerequisites.mjs'
import { presetRules } from '../eslint-preset.mjs'

// Lint scope: the .mjs files under integrations/shared/ and integrations/opencode/plugin/, integrations/opencode/plugin/*.ts, integrations/shared/config/knip.config.js and
// integrations/shared/config/.dependency-cruiser.mjs (both decide what a gate sees; tsc checks their JSDoc types — a test imports the
// first, integrations/shared/tsconfig.json names the second, which a wildcard would skip as a dot-file).
//   - the engines (integrations/claude-code/src/*.js, generated into integrations/claude-code/workflows/*.js) are NOT linted as files and cannot be: they
//     carry top-level export + await + return and only parse inside the Workflow sandbox wrapper — the same reason `node --check` cannot
//     read them. `node integrations/shared/check-workflows.mjs` compiles them, and `npm run check:types:workflows`
//     type-checks them wrapped as the sandbox runs them; those are their gates.
//   - integrations/opencode/plugin/*.ts are type-checked by `npm run check:types` (tsc, integrations/opencode/plugin/tsconfig.json);
//     here they get the TypeScript parser and the type-aware rules below.
//
// Type-aware rules (typescript-eslint, devDependency only; realm @nick/craft, #137): each file is linted
// against the program its own type check builds — integrations/shared/tsconfig.json or integrations/opencode/plugin/tsconfig.json — so a
// rule sees the same types tsc does (JSDoc types in .mjs, though not a JSDoc cast: the parser drops its
// parentheses). typescript-eslint loads `typescript` from the root node_modules, hence the root
// devDependency pinned to integrations/opencode/plugin's version (integrations/shared/typescript-pin.test.mjs fails when they part).
// The whole of typescript-eslint's strict-type-checked preset is on (realm @nick/craft, #509); each rule
// eased below names why.
// Fail closed: a program missing a declared package still builds, its imports read as `any` and the rules
// go quiet, so loading this config throws unless both installs are whole (integrations/shared/lint-prerequisites.mjs).
const root = path.resolve(import.meta.dirname, '../../..')
assertLintPrerequisites(root)

const strictTypeChecked = presetRules(tseslint.configs.strictTypeChecked, 'typescript-eslint/strict-type-checked')

const typeAware = {
  ...strictTypeChecked,
  // A number in a template literal is the idiom for counts and sizes; `${String(n)}` only adds noise.
  '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
  // `() => clearTimeout(t)` is a callback, not a confusing value; braces around each only add lines.
  '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
  // `String(v ?? '')` on an unknown value narrows it to `{}`: the deliberate coercion of outside input, not an
  // object printed by mistake; a real object type is still reported.
  '@typescript-eslint/no-base-to-string': ['error', { ignoredTypeNames: ['Error', 'RegExp', 'URL', 'URLSearchParams', '{}'] }],
  // The `_` prefix marks a parameter kept for its position, as the core rule's option did before.
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
}

export default [
  {
    ignores: [
      '**/node_modules/**',
      'integrations/shared/fixtures/**',
      'integrations/shared/config/eslint.config.mjs',
      'integrations/shared/config/vitest.config.mjs',
      'integrations/shared/config/stryker.config.mjs',
      'integrations/claude-code/workflows/**',
      'integrations/claude-code/src/**',
      'integrations/opencode/plugin/node_modules/**',
      // Stryker's leftovers (gitignored): a run that ends red leaves its per-worker setup files in the root,
      // and its in-place backup of integrations/shared/ sits in .stryker-tmp/ — neither is source, both trip a wider lint.
      'stryker-setup-*.js',
      '.stryker-tmp/**',
      'reports/**',
    ],
  },
  // No inline `eslint-disable`: the complexity bars admit no exception (realm @nick/craft, #155), and no
  // other rule is waived in place either — as the engines' lint already refuses it (integrations/shared/engine-lint.mjs).
  { linterOptions: { noInlineConfig: true } },
  js.configs.recommended,
  {
    files: [
      'integrations/shared/*.mjs',
      'integrations/pi/*.mjs',
      'integrations/opencode/**/*.mjs',
      'integrations/shared/config/knip.config.js',
      'integrations/shared/config/.dependency-cruiser.mjs',
    ],
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
  {
    ...tseslint.configs.base,
    files: [
      'integrations/shared/*.mjs',
      'integrations/pi/*.mjs',
      'integrations/opencode/plugin/*.mjs',
      'integrations/opencode/plugin/tui/*.mjs',
      'integrations/opencode/plugin/*.ts',
    ],
  },
  { ...tseslint.configs.eslintRecommended, files: ['integrations/opencode/plugin/*.ts'] },
  // Core no-unused-vars reads a function type's parameter names as unused bindings; tsc's
  // noUnusedLocals/noUnusedParameters (integrations/opencode/plugin/tsconfig.json) already hold the real ones.
  { files: ['integrations/opencode/plugin/*.ts'], rules: { 'no-unused-vars': 'off' } },
  // Under verbatimModuleSyntax (integrations/opencode/plugin/tsconfig.json) `import { type X } from 'p'` is not erased:
  // it runs as `import {} from 'p'`, loading a package that a type-only reading takes for absent. Written
  // `import type`, it is erased. integrations/shared/config/.dependency-cruiser.mjs follows the same tsconfig and catches the
  // runtime import too; this keeps the shape out of the source (realm @nick/craft, #145).
  { files: ['integrations/opencode/plugin/*.ts'], rules: { '@typescript-eslint/no-import-type-side-effects': 'error' } },
  {
    files: ['integrations/shared/*.mjs', 'integrations/pi/*.mjs'],
    languageOptions: { parserOptions: { project: ['./integrations/shared/tsconfig.json'], tsconfigRootDir: root } },
    rules: typeAware,
  },
  {
    files: ['integrations/opencode/plugin/*.mjs', 'integrations/opencode/plugin/tui/*.mjs', 'integrations/opencode/plugin/*.ts'],
    languageOptions: { parserOptions: { project: ['./integrations/opencode/plugin/tsconfig.json'], tsconfigRootDir: root } },
    rules: typeAware,
  },
  // Tests feed deliberately ill-typed input and read JSON.parse results through `any`; casting each fixture
  // to a type is a claim no check backs, so the no-unsafe-* family holds only the shipped code.
  {
    files: ['integrations/shared/*.test.mjs', 'integrations/pi/*.test.mjs', 'integrations/opencode/plugin/*.test.mjs'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  // A stub is `async` because the contract it fakes is, not because of its body; `Promise.resolve` wrappers
  // only add noise, and a sync stub would turn a rejection the test exercises into a throw.
  {
    files: ['integrations/shared/*.test.mjs', 'integrations/pi/*.test.mjs', 'integrations/opencode/plugin/*.test.mjs'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  // This check compiles each shipped engine with `new Function` without running it: that is its job.
  { files: ['integrations/shared/check-workflows.mjs'], rules: { '@typescript-eslint/no-implied-eval': 'off' } },
  // Every linted function, tests included; the engines get the same rules through integrations/shared/engine-lint.mjs.
  {
    files: [
      'integrations/shared/*.mjs',
      'integrations/pi/*.mjs',
      'integrations/opencode/**/*.mjs',
      'integrations/opencode/plugin/*.ts',
      'integrations/shared/config/knip.config.js',
      'integrations/shared/config/.dependency-cruiser.mjs',
    ],
    plugins: { sonarjs },
    rules: COMPLEXITY_RULES,
  },
]
