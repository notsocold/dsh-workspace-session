/**
 * Text snapshot format shared by the exporter and importer.
 *
 * A workspace snapshot is one newline-delimited JSON file per session:
 *
 * ```jsonl
 * {"type":"session","version":4,"id":"session-...","createdAt":...,"cwd":"/original/project",...}
 * {"type":"turn/start","seq":0,...}
 * ...
 * ```
 *
 * The first line carries the same header shape the JSONL backend writes, so a
 * snapshot stays human-readable and git-friendly. The `cwd` field keeps the
 * session's original project path (`originCwd`) so a machine that imports the
 * snapshot can remap it to its own workspace path.
 *
 * @module dsh-workspace-session/lib/snapshot
 */

import { open, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { encodeSegment, sha256, stableStringify } from './util.js'

/** Current session log format version accepted by snapshots. */
export const SESSION_FORMAT_VERSION = 4

/** Fields allowed in a physical Session header. */
const HEADER_FIELDS = [
  'version', 'id', 'createdAt', 'cwd', 'parentSession',
  'isSeeded', 'origin', 'delegationDepth', 'agentPreset',
]

/**
 * Pick the physical header fields from a logical header.
 * @param {Record<string, unknown>} header - logical header.
 * @returns {Record<string, unknown>} physical header.
 */
function pickHeader(header) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const field of HEADER_FIELDS) {
    if (header[field] !== undefined) out[field] = header[field]
  }
  out.delegationDepth = header.delegationDepth ?? 0
  return out
}

/**
 * Build the snapshot header for export, keeping the original workspace path.
 * @param {Record<string, unknown>} header - header read from persistence.
 * @param {string} originCwd - the session's original project directory.
 * @returns {Record<string, unknown>} snapshot header.
 */
export function snapshotHeader(header, originCwd) {
  return { type: 'session', ...pickHeader({ ...header, cwd: originCwd }) }
}

/**
 * Build the header used to recreate a native session on this machine.
 * @param {Record<string, unknown>} header - snapshot header.
 * @param {string} workspacePath - this machine's workspace directory.
 * @returns {Record<string, unknown>} import header.
 */
export function importHeader(header, workspacePath) {
  const picked = pickHeader({ ...header, cwd: workspacePath })
  return { ...picked }
}

/**
 * Serialize one session snapshot.
 * @param {{ header: Record<string, unknown>, events: readonly Record<string, unknown>[] }} snapshot - session data.
 * @returns {string} JSONL text ending with one newline.
 */
export function serializeSnapshot(snapshot) {
  const lines = [JSON.stringify(snapshot.header), ...snapshot.events.map(event => JSON.stringify(event))]
  return lines.join('\n') + '\n'
}

/**
 * Parse one snapshot text.
 * @param {string} text - JSONL snapshot text.
 * @returns {{ header: Record<string, unknown>, events: Record<string, unknown>[] }} parsed snapshot.
 * @throws {Error} when the header or event sequence is invalid.
 */
export function parseSnapshot(text) {
  const lines = text.split('\n').filter(line => line.trim() !== '')
  if (lines.length === 0) throw new Error('snapshot is empty')
  let header
  try {
    header = JSON.parse(lines[0])
  } catch (error) {
    throw new Error(`snapshot header is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header)) {
    throw new Error('snapshot header is not an object')
  }
  if (header.type !== 'session') throw new Error('snapshot header is missing type "session"')
  if (typeof header.id !== 'string' || header.id === '') throw new Error('snapshot header has no id')
  if (typeof header.version !== 'number') throw new Error('snapshot header has no version')
  if (typeof header.createdAt !== 'number') throw new Error('snapshot header has no createdAt')
  if (typeof header.isSeeded !== 'boolean') throw new Error('snapshot header has no isSeeded')
  const events = []
  for (let index = 1; index < lines.length; index += 1) {
    let event
    try {
      event = JSON.parse(lines[index])
    } catch (error) {
      throw new Error(`snapshot event line ${index} is not JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error(`snapshot event line ${index} is not an object`)
    }
    if (event.seq !== index - 1) {
      throw new Error(`snapshot event line ${index} has seq ${String(event.seq)}, expected ${index - 1}`)
    }
    events.push(event)
  }
  return { header, events }
}

/**
 * Find the exact fork-inherited prefix length from the seed marker event.
 * @param {readonly Record<string, unknown>[]} events - snapshot events.
 * @returns {number} inherited event count, or 0 when no inherited marker exists.
 */
export function findInheritedEventCount(events) {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'session/end-seed' && event.data?.inherited === true) return index
  }
  return 0
}

/**
 * Normalize one event for cross-machine comparison: the effective working
 * directory is machine-specific and is intentionally ignored.
 * @param {Record<string, unknown>} event - event value.
 * @returns {Record<string, unknown>} comparable event.
 */
export function normalizeEventForCompare(event) {
  if (event?.type !== 'working-directory/change' || event.data === null || typeof event.data !== 'object') {
    return event
  }
  return { ...event, data: { ...event.data, cwd: '<cwd>' } }
}

/**
 * Comparable text of one event.
 * @param {Record<string, unknown>} event - event value.
 * @returns {string} stable JSON text.
 */
export function eventComparableText(event) {
  return stableStringify(normalizeEventForCompare(event))
}

/**
 * Comparable text of an event sequence.
 * @param {readonly Record<string, unknown>[]} events - event values.
 * @returns {string[]} one comparable text per event.
 */
export function comparableEvents(events) {
  return events.map(eventComparableText)
}

/**
 * Rewrite every committed working-directory transition to this machine's
 * workspace path. System prompt context carries the current directory, and the
 * session's header cwd is rewritten separately.
 * @param {readonly Record<string, unknown>[]} events - source events.
 * @param {string} cwd - target directory.
 * @returns {Record<string, unknown>[]} rewritten events.
 */
export function rewriteWorkingDirectory(events, cwd) {
  return events.map(event => {
    if (event?.type !== 'working-directory/change'
      || event.data === null || typeof event.data !== 'object'
      || event.data.cwd === cwd) {
      return event
    }
    return { ...event, data: { ...event.data, cwd } }
  })
}

/**
 * Fingerprint of the last comparable event, used as an index hint.
 * @param {readonly Record<string, unknown>[]} events - event values.
 * @returns {string | undefined} fingerprint or undefined for an empty log.
 */
export function lastEventFingerprint(events) {
  const last = events.at(-1)
  return last === undefined ? undefined : sha256(eventComparableText(last))
}

/**
 * Snapshot file path for one session.
 * @param {string} workspacePath - workspace directory.
 * @param {string} sessionId - session id.
 * @returns {string} absolute snapshot path.
 */
export function snapshotPath(workspacePath, sessionId) {
  return join(workspacePath, '.dsh', 'sessions', encodeSegment(sessionId), 'session.v4.jsonl')
}

/**
 * Workspace session root.
 * @param {string} workspacePath - workspace directory.
 * @returns {string} absolute root path.
 */
export function workspaceSessionRoot(workspacePath) {
  return join(workspacePath, '.dsh', 'sessions')
}

/**
 * Read only the first line (the header) of an existing snapshot.
 *
 * This is used as a fallback for the workspace index: the snapshot header is
 * the authoritative `originCwd`, so the index file can stay machine-local and
 * be gitignored without changing export behavior.
 *
 * @param {string} path - snapshot file.
 * @param {number} [maxBytes] - bytes read from the head of the file.
 * @returns {Promise<Record<string, unknown> | undefined>} header or undefined.
 */
export async function readSnapshotHeader(path, maxBytes = 256 * 1024) {
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const line = text.split('\n')[0]
    if (line === '') return undefined
    const header = JSON.parse(line)
    return header !== null && typeof header === 'object' && !Array.isArray(header) ? header : undefined
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Read and parse one snapshot file with a byte bound.
 * @param {string} path - snapshot file.
 * @param {number} maxBytes - maximum accepted size.
 * @returns {Promise<{ header: Record<string, unknown>, events: Record<string, unknown>[], text: string }>} parsed snapshot.
 */
export async function readSnapshotFile(path, maxBytes) {
  const buffer = await readFile(path)
  if (buffer.byteLength > maxBytes) {
    throw new Error(`snapshot ${path} exceeds ${maxBytes} bytes`)
  }
  const text = buffer.toString('utf8')
  return { ...parseSnapshot(text), text }
}

/**
 * Directory of a snapshot file (the session directory).
 * @param {string} path - snapshot file.
 * @returns {string} parent directory.
 */
export function snapshotDirectory(path) {
  return dirname(path)
}
