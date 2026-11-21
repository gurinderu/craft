// Globals Node has and the Workflow sandbox lacks, each observed undefined by a probe workflow
// (`TextEncoder`, `TextDecoder`, `process`, `require`: realm @nick/craft, #135; `performance` — and
// `process` — on 2026-09-19, integrations/shared/agent-deadline.mjs). The engine harness shadows each, so a test run
// fails where a live run would. The static gate needs no list: integrations/shared/built-sandbox-names.mjs compiles
// every built engine against the sandbox declarations alone.
export const SANDBOX_ABSENT = ['TextEncoder', 'TextDecoder', 'process', 'require', 'performance']
