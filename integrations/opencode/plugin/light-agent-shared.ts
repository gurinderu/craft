// What the light review-task agent's two lightenings share: 2.x's (light-agent.ts) and 1.x's (light-agent-v1.ts).
import { TASK_AGENT } from './review-children.ts'

/** How a rule file the host loaded on the way begins (realm @nick/craft, nodes #695, #698). */
export const LOADED_RULES = 'Instructions from: '

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isList(v: unknown): v is unknown[] {
  return Array.isArray(v)
}

/** The reason of whatever was thrown, as one line can say it. */
export function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** One line per distinct reason: a defect met on every request is not said on every request. */
export function oncePerReason(log: (line: string) => void): (reason: string) => void {
  const said = new Set<string>()
  return reason => {
    if (said.has(reason)) return
    said.add(reason)
    log(`craft: could not lighten the ${TASK_AGENT} agent's context on this OpenCode: ${reason}`)
  }
}
