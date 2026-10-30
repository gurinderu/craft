// Test infrastructure: what the logger agent runs, replayed through the real craft-log-run CLI. An engine test hands
// a logger dispatch's prompt here, and the checkpoint or record it asks for lands in a real store from a real git
// checkout — so a test reads the index line a live run would file, not the payload the engine sent.
import { run } from './craft-log-run.mjs'

/**
 * The `node "$CRAFT_LOGGER" <command> <flags>` line of the prompt, with the payload the prompt carries on stdin,
 * run in `repo` against `store`; answered as the logger agent answers a checkpoint (its runDir) or a record.
 * @param {string} prompt @param {string} repo @param {string} store
 * @returns {Promise<{ runDir: string, error: string } | { ok: boolean, error?: string }>}
 */
export async function asLogger(prompt, repo, store) {
  // The session flag is shell-expanded from an unset variable here, so it expands to nothing.
  const line = (/node "\$CRAFT_LOGGER" (.*?)--project "\$PWD"/.exec(prompt)?.[1] ?? '').replace(/\$\{[^}]*\}/g, '')
  const argv = [...line.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map(m => m[1] != null ? m[1].replace(/'\\''/g, "'") : String(m[2]))
  const payload = prompt.split(/\n(?:PAYLOAD|RECORD):\n/)[1] ?? 'null'
  const r = await run([...argv, '--store', store, '--project', repo], {}, repo, () => payload)
  if (r.exitCode !== 0) return argv[0] === 'checkpoint' ? { runDir: '', error: r.stderr.join('\n') } : { ok: false, error: r.stderr.join('\n') }
  return argv[0] === 'checkpoint' ? { runDir: JSON.parse(String(r.stdout[0])).runDir, error: '' } : { ok: true }
}
