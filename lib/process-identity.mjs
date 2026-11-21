// Native process incarnations for writer admission (realm @nick/craft, node #563).
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { cachedBinary } from './craft-bin.mjs'

const IDENTITY = /^v1_[0-9a-f]{32}_[0-9a-f]{16}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @param {number} deadline */
export function remaining(deadline) {
  const ms = deadline - performance.now()
  if (!(ms > 0)) throw new Error('index.jsonl stays locked: waiting for writer (admission deadline)')
  return ms
}

/** @param {number} pid @returns {string | null} */
function linuxIdentity(pid) {
  const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  if (!UUID.test(boot)) throw new Error('invalid process boot identity')
  const stat = linuxStat(pid)
  if (stat === null) return null
  const incarnation = statIncarnation(stat, pid)
  return incarnation === null ? null : `v1_${boot.replaceAll('-', '').toLowerCase()}_${incarnation}`
}

/** @param {number} pid @returns {string | null} */
function linuxStat(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
    // A hidden /proc entry is not proof of death (hidepid can also return ENOENT).
    try {
      process.kill(pid, 0)
    } catch (probe) {
      if (/** @type {NodeJS.ErrnoException} */ (probe).code === 'ESRCH') return null
      throw probe
    }
    throw error
  }
}

/** @param {string} stat @param {number} pid */
function statIncarnation(stat, pid) {
  const close = stat.lastIndexOf(')')
  const fields = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/)
  const ticks = fields[19] ?? ''
  if (!stat.startsWith(`${pid} (`) || stat[close + 1] !== ' ' || !/^(0|[1-9]\d*)$/.test(ticks)) throw new Error('invalid process stat identity')
  if (!/^[RSDZTtXxKWPI]$/.test(fields[0] ?? '')) throw new Error('invalid process stat state')
  const incarnation = BigInt(ticks)
  if (incarnation > 0xffffffffffffffffn) throw new Error('invalid process stat identity')
  if (/^[ZXx]$/.test(fields[0] ?? '')) return null
  return incarnation.toString(16).padStart(16, '0')
}

/** @param {number} pid @param {number} deadline @returns {string | null} */
function helperIdentity(pid, deadline) {
  const bin = cachedBinary(process.env, os.homedir())
  if (!bin) throw new Error('process identity requires the cached craft binary of this plugin version (or CRAFT_BIN); no download during admission')
  const timeout = Math.floor(remaining(deadline))
  if (timeout < 1) throw new Error('index.jsonl stays locked: admission deadline leaves no helper millisecond')
  const output = execFileSync(bin, ['__craft-process-identity', '--pid', String(pid)], {
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  remaining(deadline)
  return helperResponse(output, pid)
}

/** @param {string} output @param {number} pid @returns {string | null} */
function helperResponse(output, pid) {
  /** @type {unknown} */
  const reply = JSON.parse(output)
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('invalid craft process identity response')
  const value = /** @type {Record<string, unknown>} */ (reply)
  if (Object.keys(value).sort().join(',') !== 'identity,pid,version' || value['version'] !== 1 || value['pid'] !== pid)
    throw new Error('incompatible craft process identity response')
  return identityValue(value['identity'])
}

/** @param {unknown} identity */
function identityValue(identity) {
  if (identity !== null && (typeof identity !== 'string' || identity.length !== 52 || !IDENTITY.test(identity)))
    throw new Error('invalid craft process identity')
  return identity
}

/** @param {number} pid @param {number} deadline @returns {string | null} */
export function processIdentity(pid, deadline) {
  remaining(deadline)
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new Error('invalid process identity PID')
  const identity = process.platform === 'linux' ? linuxIdentity(pid) : helperIdentity(pid, deadline)
  remaining(deadline)
  return identity
}

/** @param {string} name */
export function ticketIdentity(name) {
  const parts = /^([1-9]\d*)-(v1_[0-9a-f]{32}_[0-9a-f]{16})-([0-9a-f]{24})$/.exec(name)
  const pid = Number(parts?.[1])
  const identity = parts?.[2]
  if (!identity || parts[0] !== name || !Number.isInteger(pid) || pid > 0xffffffff) throw new Error(`invalid index writer ticket: ${name}`)
  return { pid, identity }
}
