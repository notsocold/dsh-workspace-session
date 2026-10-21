/**
 * Machine-local state and workspace-local sync indexes.
 *
 * Two files are involved:
 *
 * - `$DSH_HOME/dsh-workspace-session/state.json` — machine-local bookkeeping:
 *   workspace roots, imported sessions, scan timestamps, recent conflicts.
 * - `<workspace>/.dsh/workspace-session.json` — travels with the repository:
 *   each session's `originCwd`, export fingerprint, and last writer.
 *
 * Both are written atomically. The workspace index intentionally stores only
 * ids, paths, timestamps, and hashes — never session content.
 *
 * @module dsh-workspace-session/lib/state
 */

import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  dshHomePath, ensureDir, nowIso, readJsonFile, writeJsonAtomic, writeTextAtomic,
} from './util.js'

/** State schema version. */
export const STATE_VERSION = 1

/** Workspace index schema version. */
export const INDEX_VERSION = 1

/** Maximum retained conflict records in machine state. */
const MAX_CONFLICTS = 100

/**
 * Read the machine identity, creating it once.
 * @param {string} dir - plugin state directory.
 * @returns {Promise<string>} stable machine id.
 */
async function loadMachineId(dir) {
  const path = join(dir, 'machine-id')
  try {
    const value = (await readFile(path, 'utf8')).trim()
    if (value !== '') return value
  } catch {
    // Missing file: create one below.
  }
  const id = `${hostname()}-${randomUUID().slice(0, 8)}`
  await ensureDir(dir)
  await writeTextAtomic(path, id + '\n')
  return id
}

/** Machine-local plugin state. */
export class StateStore {
  /**
   * @param {{ home: string, logger?: { warn?: (message: string) => void } }} options - Harness home and logger.
   */
  constructor(options) {
    this.home = options.home
    this.logger = options.logger
    this.dir = dshHomePath(this.home, 'dsh-workspace-session')
    this.path = join(this.dir, 'state.json')
    this.data = {
      version: STATE_VERSION,
      machineId: '',
      workspaces: {},
      conflicts: [],
    }
  }

  /** Load state from disk. */
  async load() {
    const raw = await readJsonFile(this.path, undefined)
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      this.data = {
        version: STATE_VERSION,
        machineId: typeof raw.machineId === 'string' ? raw.machineId : '',
        workspaces: raw.workspaces !== null && typeof raw.workspaces === 'object' && !Array.isArray(raw.workspaces)
          ? raw.workspaces
          : {},
        conflicts: Array.isArray(raw.conflicts) ? raw.conflicts.slice(0, MAX_CONFLICTS) : [],
      }
    }
    if (this.data.machineId === '') this.data.machineId = await loadMachineId(this.dir)
    return this.data
  }

  /** Persist state atomically. */
  async save() {
    await ensureDir(this.dir)
    await writeJsonAtomic(this.path, this.data)
  }

  /** @returns {string} this machine's id. */
  get machineId() {
    return this.data.machineId
  }

  /**
   * One workspace's machine-local record.
   * @param {string} workspacePath - canonical workspace path.
   * @returns {{ root: string, lastScanAt?: string, sessions: Record<string, any>, conflicts: any[] }} record.
   */
  workspace(workspacePath) {
    if (this.data.workspaces[workspacePath] === undefined) {
      this.data.workspaces[workspacePath] = {
        root: join(workspacePath, '.dsh', 'sessions'),
        sessions: {},
        conflicts: [],
      }
    }
    return this.data.workspaces[workspacePath]
  }

  /**
   * Read one imported-session record.
   * @param {string} workspacePath - workspace path.
   * @param {string} sessionId - session id.
   * @returns {any | undefined} record.
   */
  session(workspacePath, sessionId) {
    return this.workspace(workspacePath).sessions[sessionId]
  }

  /**
   * Merge one imported-session record and persist state.
   * @param {string} workspacePath - workspace path.
   * @param {string} sessionId - session id.
   * @param {Record<string, unknown>} patch - fields to merge.
   * @returns {Promise<void>}
   */
  async updateSession(workspacePath, sessionId, patch) {
    const record = this.workspace(workspacePath)
    record.sessions[sessionId] = { ...record.sessions[sessionId], ...patch, updatedAt: nowIso() }
    await this.save()
  }

  /**
   * Record a completed workspace scan.
   * @param {string} workspacePath - workspace path.
   * @returns {Promise<void>}
   */
  async markScan(workspacePath) {
    this.workspace(workspacePath).lastScanAt = nowIso()
    await this.save()
  }

  /**
   * Append one conflict record and persist state.
   * @param {Record<string, unknown>} conflict - conflict description.
   * @returns {Promise<void>}
   */
  async addConflict(conflict) {
    this.data.conflicts.unshift({ ...conflict, at: nowIso() })
    this.data.conflicts = this.data.conflicts.slice(0, MAX_CONFLICTS)
    await this.save()
  }
}

/** Workspace-local sync index (`<workspace>/.dsh/workspace-session.json`). */
export class WorkspaceIndex {
  /**
   * @param {string} workspacePath - canonical workspace path.
   */
  constructor(workspacePath) {
    this.path = join(workspacePath, '.dsh', 'workspace-session.json')
    this.data = { version: INDEX_VERSION, sessions: {} }
  }

  /** Load the index, tolerating an absent or invalid file. */
  async load() {
    const raw = await readJsonFile(this.path, undefined)
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      this.data = {
        version: INDEX_VERSION,
        sessions: raw.sessions !== null && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions)
          ? raw.sessions
          : {},
      }
    }
    return this.data
  }

  /** Persist the index atomically. */
  async save() {
    await ensureDir(join(this.path, '..'))
    await writeJsonAtomic(this.path, this.data)
  }

  /**
   * Read one exported-session record.
   * @param {string} sessionId - session id.
   * @returns {any | undefined} record.
   */
  session(sessionId) {
    return this.data.sessions[sessionId]
  }

  /**
   * Merge one exported-session record and persist.
   * @param {string} sessionId - session id.
   * @param {Record<string, unknown>} patch - fields to merge.
   * @returns {Promise<void>}
   */
  async update(sessionId, patch) {
    this.data.sessions[sessionId] = { ...this.data.sessions[sessionId], ...patch }
    await this.save()
  }
}
