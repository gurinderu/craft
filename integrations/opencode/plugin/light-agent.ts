// The light review-task agent's context on OpenCode 2.x. Two hooks carry this agent's model requests: `context`, the
// request of a step, and `compaction`, the request that summarizes the conversation for the agent with the context as
// the host stored it. Each sees its request before it goes out; the host keeps what the hook changes in place and drops
// what it returns (2.2.7, realm @nick/craft, node #697). For the review-task agent's requests both leave the
// repository's instructions out of what the provider gets, closing what the agent's file cannot: a permission denies a
// call, not the offer (node #694). Every other agent's request passes as it came.
//   • `system`: the part that carries the instructions keeps the host's own sections only, the date and the
//     environment (node #695). It is read by the list of sections beside its text when the list accounts for the text
//     exactly, else by the text's end — its last environment block must end the text, a trailing newline allowed.
//     A part that names sections and cannot be cut is removed, not sent with the rules; a part naming nothing is
//     left alone.
//   • `messages`: a rule file the host loads on the way (a user message beginning `Instructions from: `) and the
//     notices of the `system` role that are only text are dropped; a system message that is not only text, and a
//     compaction summary, stay — what the summarizer quoted, it quoted.
//   • `tools`: a record is left the four the agent reads a repository with; a list is not read as one.
// A request the hook cannot read costs the host nothing: its shape is left as it came, and a throw is caught and
// said once per reason, never to the request (node #698). What this is worth is measured by the REALITY.md row's run
// on each 2.x bump (node #699).
import type { V2Context, V2ContextHookInput, V2Registration } from './opencode-v2.js'
import { TASK_AGENT } from './review-children.ts'

/** A section of the instructions part as 2.2.7 names it under `metadata.experimental.instructions` (node #697). */
type Section = { key: string; text: string }

/** What became of one system part: cut to the host's own sections, removed, or left as it came. */
type Verdict = 'kept' | 'removed' | 'untouched'

/** The sections of the instructions part that are the host's own: the date and the environment (node #695). */
const OWN_SECTIONS = new Set(['core/date', 'core/environment'])
const ENV_HEAD = 'Here is some useful information about the environment you are running in:'
/** The environment block ends the part's text, a trailing newline allowed: what follows it is not known to be the host's. */
const ENV_END = /\n<\/env>\n?$/
const DATE_LINE = /^Today's date: \w{3} \w{3} \d{1,2} \d{4}$/
/** How a rule file the host loaded on the way begins (node #697). */
const LOADED_RULES = 'Instructions from: '
/** What the light agent reads a repository with; the agent's file denies the rest (node #694). */
const TOOLS = new Set(['glob', 'grep', 'read', 'shell'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isList(v: unknown): v is unknown[] {
  return Array.isArray(v)
}

/**
 * The part's list of sections — an empty one counts — when it is a list of `{key, text}` strings, else undefined.
 */
function sectionsOf(part: Record<string, unknown>): Section[] | undefined {
  const meta = part['metadata']
  const exp = isRecord(meta) ? meta['experimental'] : undefined
  const list = isRecord(exp) ? exp['instructions'] : undefined
  if (!isList(list)) return undefined
  const sections: Section[] = []
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry['key'] !== 'string' || typeof entry['text'] !== 'string') return undefined
    sections.push({ key: entry['key'], text: entry['text'] })
  }
  return sections
}

/** Whether the part's text is exactly its sections joined by blank lines, as 2.2.7 writes it (node #697). */
function faithful(list: Section[], text: string): boolean {
  return list.map(section => section.text).join('\n\n') === text
}

/**
 * The host's own tail of an instructions part read by its text: its last environment block, which must begin a line
 * and end the text, with the date line before it when there is one. Anything after the block makes the tail
 * unreadable: what a newer host adds there is not known to be its own (node #695).
 */
function ownTail(text: string): string | undefined {
  const at = text.lastIndexOf(ENV_HEAD)
  if (at < 0 || (at > 0 && text[at - 1] !== '\n')) return undefined
  const block = text.slice(at)
  if (!ENV_END.test(block)) return undefined
  const head = text.slice(0, at).trimEnd()
  const date = head.slice(head.lastIndexOf('\n') + 1)
  return DATE_LINE.test(date) ? `${date}\n\n${block}` : block
}

/** The list beside the text says what the text now holds; it is rewritten for a trusted list only. */
function setOwnList(part: Record<string, unknown>, own: Section[]): void {
  const meta = part['metadata']
  const exp = isRecord(meta) ? meta['experimental'] : undefined
  if (isRecord(exp)) exp['instructions'] = own
}

/** A trusted list: the text becomes its own sections, or the part goes when it names none. */
function byList(part: Record<string, unknown>, list: Section[]): Verdict {
  const own = list.filter(section => OWN_SECTIONS.has(section.key))
  if (own.length === 0) return 'removed'
  part['text'] = own.map(section => section.text).join('\n\n')
  setOwnList(part, own)
  return 'kept'
}

/**
 * No list to trust: the text's own tail is kept, the list left alone. With no tail, a part that names sections goes
 * and one naming nothing stays.
 */
function byTail(part: Record<string, unknown>, text: string, list: Section[] | undefined): Verdict {
  const tail = ownTail(text)
  if (tail === undefined) return list === undefined ? 'untouched' : 'removed'
  part['text'] = tail
  return 'kept'
}

function trimPart(part: unknown): Verdict {
  if (!isRecord(part)) return 'untouched'
  const text = part['text']
  if (typeof text !== 'string') return 'untouched'
  const list = sectionsOf(part)
  return list !== undefined && faithful(list, text) ? byList(part, list) : byTail(part, text, list)
}

/** The one text of a message that is only text — a string, or text parts joined by newlines — else undefined. */
function textOf(message: Record<string, unknown>): string | undefined {
  const content = message['content']
  if (typeof content === 'string') return content
  if (!isList(content)) return undefined
  const texts: string[] = []
  for (const part of content) {
    if (!isRecord(part) || part['type'] !== 'text' || typeof part['text'] !== 'string') return undefined
    texts.push(part['text'])
  }
  return texts.join('\n')
}

/**
 * A message that carries the repository's instructions: a rule file the host loaded on the way, or a text-only
 * notice of the `system` role (node #695).
 */
function isNotice(message: unknown): boolean {
  if (!isRecord(message)) return false
  const text = textOf(message)
  if (text === undefined) return false
  const role = message['role']
  return role === 'system' || (role === 'user' && text.startsWith(LOADED_RULES))
}

/** Removes from a list, in place and from its end, the items `drop` says removed. */
function cutList(list: unknown, drop: (item: unknown) => boolean): void {
  if (!isList(list)) return
  for (let i = list.length - 1; i >= 0; i--) if (drop(list[i])) list.splice(i, 1)
}

/** Leaves a record of tools the four the light agent is offered; anything else is not read as one. */
function cutTools(tools: unknown): void {
  if (!isRecord(tools)) return
  for (const name of Object.keys(tools)) if (!TOOLS.has(name)) Reflect.deleteProperty(tools, name)
}

/**
 * Lighten one model request in place, when it is the review-task agent's: the instructions part of `system` cut to
 * the host's own sections or removed, the rule files and notices dropped from `messages`, `tools` left the four.
 * Every other agent's request, and anything not shaped as recorded, is left as it came (nodes #694, #695, #697).
 */
export function lighten(input: V2ContextHookInput): void {
  const request: unknown = input
  if (!isRecord(request) || request['agent'] !== TASK_AGENT) return
  cutList(request['system'], part => trimPart(part) === 'removed')
  cutList(request['messages'], isNotice)
  cutTools(request['tools'])
}

/** The reason of whatever was thrown, as one line can say it. */
function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** One line per distinct reason: a defect met on every request is not said on every request. */
function oncePerReason(log: (line: string) => void): (reason: string) => void {
  const said = new Set<string>()
  return reason => {
    if (said.has(reason)) return
    said.add(reason)
    log(`craft: could not lighten the ${TASK_AGENT} agent's context on this OpenCode: ${reason}`)
  }
}

/** The 2.x hooks that carry the review-task agent's model requests: a step's own and the compaction's (node #697). */
const REQUEST_HOOKS: readonly ['context', 'compaction'] = ['context', 'compaction']

/**
 * The 2.x plugin's hooks for the light agent: the same lightening on `context` and on `compaction`, disposed with the
 * plugin. It never costs the host a request: a throw inside a hook is caught and said once per reason on `log`; a 2.x
 * that refuses one registration is said the same way, naming the hook, and the other stands (node #698).
 */
export async function hookLightAgent(ctx: V2Context, log: (line: string) => void = console.error): Promise<() => Promise<void>> {
  const say = oncePerReason(log)
  const registrations: V2Registration[] = []
  for (const name of REQUEST_HOOKS) {
    try {
      registrations.push(
        await ctx.session.hook(name, input => {
          try {
            lighten(input)
          } catch (e) {
            say(reasonOf(e))
          }
        }),
      )
    } catch (e) {
      say(`${name} hook: ${reasonOf(e)}`)
    }
  }
  return async () => {
    for (const registration of registrations) await registration.dispose()
  }
}
