// Fixture (CommonJS spellings) for .semgrep/child-process.yml; not scanned by the gate.
const cp = require('node:child_process')

function bad(arg) {
  // ruleid: craft-child-process-shell-command
  cp.exec(`rm ${arg}`)
  // ruleid: craft-child-process-shell-command
  require('child_process').execSync('ls ' + arg)
}

function good(arg) {
  // ok: craft-child-process-shell-command
  cp.execFile('rm', [arg])
}
module.exports = { bad, good }
