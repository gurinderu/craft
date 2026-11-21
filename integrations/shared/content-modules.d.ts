// A content/ prompt template imported as a module: its raw text (integrations/shared/content.mjs), inlined by the engine build's
// text loader (integrations/shared/engine-bundle.mjs) and served the same way to the tests (integrations/shared/config/vitest.config.mjs).
declare module '*.md' {
  const text: string
  export default text
}
