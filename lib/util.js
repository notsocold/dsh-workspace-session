/**
 * Small shared helpers for dsh-workspace-session.
 *
 * The plugin is a zero-dependency, build-free ESM bundle: it only uses Node
 * built-ins plus the Cordis services it injects.
 *
 * @module dsh-workspace-session/lib/util
 */

import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Environment variable naming the Harness home. */
const DSH_HOME_ENV = 'DSH_HOME'

/**
 * Resolve the Harness home the same way DSH does: explicit value, then
 * `$DSH_HOME`, then `~/.dsh`.
 * @param {string | undefined} explicit - an explicit root, when a caller has one.
 * @returns {string} absolute Harness home.
 */
export function resolveDshHome(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit
  const env = process.env[DSH_HOME_ENV]
  if (typeof env === 'string' && env.trim() !== '') return env
  return join(homedir(), '.dsh')
}

/**
 * Join path parts below the Harness home.
 * @param {string} home - Harness home.
 * @param {...string} parts - path segments.
 * @returns {string} absolute path.
 */
export function dshHomePath(home, ...parts) {
  return join(home, ...parts)
}

/**
 * Create a directory recursively.
 * @param {string} path - directory path.
 * @returns {Promise<void>}
 */
export async function ensureDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
}

/**
 * Read one JSON file, returning `fallback` for a missing file.
 * @param {string} path - file path.
 * @param {unknown} fallback - value for ENOENT.
 * @returns {Promise<any>} parsed JSON or the fallback.
 */
export async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

/**
 * Write JSON atomically: write a sibling temp file, then rename over the target.
 * @param {string} path - target file.
 * @param {unknown} value - JSON-serializable value.
 * @param {{ mode?: number }} [options] - file mode.
 * @returns {Promise<void>}
 */
export async function writeJsonAtomic(path, value, options = {}) {
  await writeTextAtomic(path, JSON.stringify(value, null, 2) + '\n', options)
}

/**
 * Write text atomically: write a sibling temp file, then rename over the target.
 * @param {string} path - target file.
 * @param {string} text - file content.
 * @param {{ mode?: number }} [options] - file mode.
 * @returns {Promise<void>}
 */
export async function writeTextAtomic(path, text, options = {}) {
  await ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(tmp, text, { encoding: 'utf8', mode: options.mode ?? 0o600 })
    if (options.mode !== undefined) await chmod(tmp, options.mode)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * SHA-256 of a string, prefixed for display.
 * @param {string} text - input text.
 * @returns {string} `sha256:<hex>`.
 */
export function sha256(text) {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Encode an arbitrary string as one safe path segment. Mirrors the DSH JSONL
 * backend's rule so workspace snapshots keep readable session ids.
 * @param {string} raw - raw value.
 * @returns {string} safe path segment.
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Stat a path, returning `undefined` for ENOENT.
 * @param {string} path - path to stat.
 * @returns {Promise<import('node:fs').Stats | undefined>} stats or undefined.
 */
export async function statOrUndefined(path) {
  try {
    return await stat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Resolve the canonical path of a directory, returning undefined when it does
 * not exist or is not a directory.
 * @param {string} path - candidate path.
 * @returns {Promise<string | undefined>} canonical directory path.
 */
export async function realpathDirectory(path) {
  try {
    const { realpath } = await import('node:fs/promises')
    const resolved = await realpath(path)
    const info = await stat(resolved)
    return info.isDirectory() ? resolved : undefined
  } catch {
    return undefined
  }
}

/**
 * Current time as an ISO string.
 * @returns {string} ISO timestamp.
 */
export function nowIso() {
  return new Date().toISOString()
}

/**
 * A short random suffix for temp/backup names.
 * @returns {string} hex suffix.
 */
export function randomSuffix() {
  return randomUUID().replaceAll('-', '').slice(0, 12)
}

/**
 * Whether a value is a plain object.
 * @param {unknown} value - candidate.
 * @returns {boolean} true for plain objects.
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Serialize a value with recursively sorted object keys, so equal values always
 * produce equal text regardless of insertion order.
 * @param {unknown} value - JSON-compatible value.
 * @returns {string} stable JSON text.
 */
export function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (isRecord(value)) {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

/**
 * Resolve after a delay.
 * @param {number} ms - delay in milliseconds.
 * @returns {Promise<void>} resolves after the delay.
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Convert a thrown value into a stable error payload.
 * @param {unknown} error - thrown value.
 * @returns {{ code: string, message: string }} payload.
 */
export function errorPayload(error) {
  const code = typeof error?.code === 'string' ? error.code : 'internal'
  const message = error instanceof Error ? error.message : String(error)
  return { code, message }
}
