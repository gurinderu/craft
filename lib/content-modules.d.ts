// A content/ prompt template imported as a module: its raw text (lib/content.mjs), inlined by the engine build's
// text loader (lib/engine-bundle.mjs) and served the same way to the tests (vitest.config.mjs).
declare module '*.md' {
  const text: string
  export default text
}
