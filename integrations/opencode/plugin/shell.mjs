// The one way the plugin reads its workspace: `bash -lc <probe>` through execFile (an argument array, no
// shell of Node's own), in the workspace's directory. Both runtimes share it: 2.x hands a plugin no shell,
// and the 1.x `$` was Bun's, which the tests could not reach without faking Bun.
import { execFile } from 'node:child_process'

/**
 * A probe runner bound to `cwd`: it resolves to the probe's trimmed stdout, or "" when bash failed or the
 * probe exited non-zero — every caller treats "" as "unknown", never as an error.
 * @param {string} cwd
 * @returns {(cmd: string) => Promise<string>}
 */
export function shellIn(cwd) {
  return cmd => new Promise(resolve => {
    execFile('bash', ['-lc', cmd], { ...(cwd ? { cwd } : {}), maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout).trim())
    })
  })
}
