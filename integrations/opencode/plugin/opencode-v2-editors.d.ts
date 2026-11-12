// What the `agent`, `command` and `skill` editors of OpenCode 2.x's plugin context (opencode-v2.d.ts) take, written by
// hand — observed on 2.2.7, internal: read from the binary's `ctx.agent.transform`,
// `ctx.command.transform` and `ctx.skill.transform` and the built-in plugins that use them; re-read on each 2.x bump).
// `update` creates a missing agent from its defaults (`name` = id, mode primary, everything allowed) before the edit; a
// rule list is read last match first. A command has no template: `execute` gets the invocation and prompts itself, as
// the built-in commands do. All three editors key by id/name, so a second add replaces the first.
export interface V2PermissionRule {
  action: string
  resource: string
  effect: 'allow' | 'deny' | 'ask'
}

export interface V2AgentDraft {
  id: string
  name: string
  description?: string
  mode: 'subagent' | 'primary' | 'all'
  hidden: boolean
  system?: string
  permissions: V2PermissionRule[]
}

export interface V2CommandInvocation {
  sessionID: string
  prompt: { text: string } & Record<string, unknown>
  delivery?: string
}

export interface V2CommandDefinition {
  name: string
  description?: string
  execute(invocation: V2CommandInvocation): Promise<unknown>
}

export interface V2Skill {
  id: string
  name: string
  description?: string
  // The SKILL.md file's absolute path.
  path: string
  // The body after the frontmatter.
  content: string
}
