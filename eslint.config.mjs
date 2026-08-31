import js from '@eslint/js'

// Lint scope is the .mjs files under lib/ and opencode/plugin/ — nothing else.
//   - workflows/*.js are NOT linted and cannot be: they carry top-level export + await + return
//     and only parse inside the Workflow sandbox wrapper — the same reason `node --check` cannot
//     read them. `node lib/check-workflows.mjs` compiles them instead; that is their gate.
//   - opencode/plugin/*.ts are NOT linted either: ESLint 9 globs only .js/.mjs/.cjs by default
//     and no TS parser is configured here. They have no gate at all — not lint, not tests, not
//     check-*.mjs. Adding a TypeScript toolchain is a separate, open decision.
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
]
