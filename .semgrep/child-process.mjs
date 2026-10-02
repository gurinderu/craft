// Fixture for .semgrep/child-process.yml, run by `semgrep --test .semgrep/`; not scanned by the gate.
import { exec, execSync, execFileSync, spawn } from 'node:child_process'
import * as cp from 'child_process'

export function bad(arg) {
  // ruleid: craft-child-process-shell-command
  exec(`ls ${arg}`)
  // ruleid: craft-child-process-shell-command
  execSync('ls ' + arg)
  // ruleid: craft-child-process-shell-command
  cp.exec(arg)
  // ruleid: craft-child-process-shell-option
  spawn('ls', [arg], { shell: true })
  // ruleid: craft-child-process-shell-option
  cp.execFileSync('ls', [arg], { cwd: '.', shell: true })
}

export function good(arg) {
  // ok: craft-child-process-shell-command
  execSync('git status')
  // ok: craft-child-process-shell-command
  execFileSync('git', ['log', arg], { encoding: 'utf8' })
  // ok: craft-child-process-shell-option
  spawn('ls', [arg], { cwd: '.' })
}
