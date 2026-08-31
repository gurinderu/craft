import js from '@eslint/js'

// Lint scope is lib/ and opencode/plugin/ only. workflows/*.js are NOT linted and cannot be:
// they carry top-level export + await + return and only parse inside the Workflow sandbox
// wrapper — the same reason `node --check` cannot read them. `node lib/check-workflows.mjs`
// compiles them instead; that is their gate.
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
