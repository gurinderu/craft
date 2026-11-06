// The agent type an engine's read-only service agents run as (realm @nick/craft, node #442): Claude Code's
// built-in Explore subagent is not handed the consumer's project instructions (CLAUDE.md, AGENTS.md), which
// every other agent type receives as an uncached block, paid again as prompt-cache writes by each agent. Explore
// refuses any command that writes a file, even under a scratch directory, so only an agent whose every command
// reads (git, grep, a read-only CLI, or no command at all) may take it — never a checkpoint, a record write,
// a build, a test or a cache fill.
export const READ_ONLY_AGENT_TYPE = 'Explore'
