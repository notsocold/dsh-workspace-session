/**
 * Importer: workspace text snapshot → native session log.
 *
 * Reads the snapshots below `<workspace>/.dsh/sessions/` and recreates or
 * fast-forwards the native session store on this machine. The native store
 * stays the only store DSH reads and writes; this module never edits an
 * existing native log in place except for appending a missing fast-forward
 * suffix through a public write handle.
 *
 * Conflict rules (default `keep-both`): never merge two diverged event
 * sequences. Back up both sides, and recreate the remote branch as a new
 * session id so both histories stay openable.
 *
 * @module dsh-workspace-session/lib/importer
 */

import { readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  SESSION_FORMAT_VERSION,
  comparableEvents,
  findInheritedEventCount,
  importHeader,
  readSnapshotFile,
  rewriteWorkingDirectory,
  serializeSnapshot,
  snapshotHeader,
} from './snapshot.js'
import { WorkspaceIndex } from './state.js'
import { attachSession, workspaceRoot } from './workspace.js'
import {
  ensureDir, nowIso, realpathDirectory, statOrUndefined, writeTextAtomic,
} from './util.js'

/**
 * Compare two event sequences by their comparable text.
 * @param {readonly Record<string, unknown>[]} nativeEvents - local stored events.
 * @param {readonly Record<string, unknown>[]} remoteEvents - snapshot events.
 * @returns {{ kind: 'equal' | 'native-ahead' | 'remote-ahead' | 'diverged', common: number }} comparison.
 */
export function compareEventSequences(nativeEvents, remoteEvents) {
  const native = comparableEvents(nativeEvents)
  const remote = comparableEvents(remoteEvents)
  let common = 0
  while (common < native.length && common < remote.length && native[common] === remote[common]) {
    common += 1
  }
  if (common === native.length && common === remote.length) return { kind: 'equal', common }
  if (common === native.length) return { kind: 'remote-ahead', common }
  if (common === remote.length) return { kind: 'native-ahead', common }
  return { kind: 'diverged', common }
}

/** Imports workspace snapshots into the native store. */
export class Importer {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
   * @param {{ config: any, state: any, logger?: { warn?: (message: string) => void } }} options - plugin services.
   */
  constructor(ctx, options) {
    this.ctx = ctx
    this.config = options.config
    this.state = options.state
    this.logger = options.logger
  }

  /**
   * Scan one workspace and import every snapshot that is new or ahead.
   * @param {any} workspace - workspace entity.
   * @param {{ force?: boolean }} [options] - rescan unchanged files.
   * @returns {Promise<Record<string, unknown>[]>} per-file results.
   */
  async importWorkspace(workspace, options = {}) {
    const root = workspaceRoot(workspace)
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const record = this.state.workspace(workspace.path)
    record.dirs ??= {}
    const results = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const file = join(root, entry.name, 'session.v4.jsonl')
      const info = await statOrUndefined(file)
      if (info === undefined) continue
      if (options.force !== true && record.dirs[entry.name] === info.mtimeMs) continue
      try {
        const result = await this.importFile(workspace, file, { force: options.force })
        result.dir = entry.name
        results.push(result)
        record.dirs[entry.name] = info.mtimeMs
      } catch (error) {
        results.push({ dir: entry.name, error: error instanceof Error ? error.message : String(error) })
        this.logger?.warn?.(`dsh-workspace-session: import of ${file} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await this.state.markScan(workspace.path)
    await this.state.save()
    return results
  }

  /**
   * Import one snapshot file.
   * @param {any} workspace - workspace entity.
   * @param {string} file - snapshot path.
   * @param {{ force?: boolean }} [options] - unused; kept for signature symmetry.
   * @returns {Promise<Record<string, unknown>>} result.
   */
  async importFile(workspace, file, options = {}) {
    const parsed = await readSnapshotFile(file, this.config.snapshotMaxBytes)
    const sourceHeader = parsed.header
    const events = parsed.events
    if (sourceHeader.version !== SESSION_FORMAT_VERSION) {
      return { skipped: 'unsupported-version', version: sourceHeader.version }
    }
    if (typeof sourceHeader.id !== 'string' || sourceHeader.id === '') return { skipped: 'no-id' }
    if (typeof sourceHeader.cwd !== 'string' || sourceHeader.cwd === '') return { skipped: 'no-cwd' }
    const id = sourceHeader.id
    const persistence = this.ctx.sessionPersistence
    if (persistence === undefined || persistence === null) return { skipped: 'no-persistence' }

    let native
    try {
      native = await persistence.stat(id)
    } catch {
      native = undefined
    }
    if (native === undefined || native === null) {
      return await this.recreate(workspace, sourceHeader, events, { reason: 'imported' })
    }

    let handle
    try {
      handle = await persistence.open(id, 'read')
      const nativeEvents = (await handle.read(0)).events
      const comparison = compareEventSequences(nativeEvents, events)
      const nativeHeader = handle.header
      if (comparison.kind === 'equal' || comparison.kind === 'native-ahead') {
        return { id, skipped: comparison.kind, eventCount: nativeEvents.length }
      }
      if (comparison.kind === 'remote-ahead') {
        const sameCwd = await this.sameDirectory(nativeHeader?.cwd, workspace.path)
        if (sameCwd) {
          const appended = await this.appendMissing(id, nativeEvents.length, events)
          await this.state.updateSession(workspace.path, id, {
            lastImportedAt: nowIso(),
            eventCount: events.length,
            originCwd: sourceHeader.cwd,
            reason: 'fast-forward',
          })
          return { id, imported: true, reason: 'fast-forward', appended }
        }
        return await this.recreate(workspace, sourceHeader, events, { reason: 'fast-forward-cwd-mismatch' })
      }
      return await this.resolveConflict(workspace, sourceHeader, events, parsed.text, nativeHeader, nativeEvents)
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  /**
   * Whether a native header cwd resolves to the workspace directory.
   * @param {string | undefined} cwd - native header cwd.
   * @param {string} workspacePath - workspace path.
   * @returns {Promise<boolean>} true when both resolve to the same directory.
   */
  async sameDirectory(cwd, workspacePath) {
    if (typeof cwd !== 'string' || cwd === '') return false
    const a = await realpathDirectory(cwd)
    const b = await realpathDirectory(workspacePath)
    return a !== undefined && b !== undefined && a === b
  }

  /**
   * Append the missing suffix of a remote snapshot to a native write handle.
   * @param {string} id - session id.
   * @param {number} nativeLength - current native event count.
   * @param {readonly Record<string, unknown>[]} events - snapshot events.
   * @returns {Promise<number>} number of appended events.
   */
  async appendMissing(id, nativeLength, events) {
    const missing = events.slice(nativeLength)
    if (missing.length === 0) return 0
    const persistence = this.ctx.sessionPersistence
    const handle = await persistence.open(id, 'write')
    try {
      await handle.append(missing)
      await handle.flush()
    } finally {
      await handle.close().catch(() => {})
    }
    return missing.length
  }

  /**
   * Recreate a snapshot as a native session.
   * @param {any} workspace - workspace entity.
   * @param {Record<string, unknown>} sourceHeader - snapshot header.
   * @param {readonly Record<string, unknown>[]} events - snapshot events.
   * @param {{ reason: string, newId?: string }} options - reason and optional new identity.
   * @returns {Promise<Record<string, unknown>>} result.
   */
  async recreate(workspace, sourceHeader, events, options) {
    const persistence = this.ctx.sessionPersistence
    const id = options.newId ?? String(sourceHeader.id)
    const index = new WorkspaceIndex(workspace.path)
    await index.load()
    const inheritedFromIndex = index.session(String(sourceHeader.id))?.inheritedEventCount
    const inherited = Number.isSafeInteger(inheritedFromIndex)
      ? inheritedFromIndex
      : findInheritedEventCount(events)
    const header = importHeader({ ...sourceHeader, id }, workspace.path)
    const rewritten = rewriteWorkingDirectory(events, workspace.path)
    const handle = await persistence.create(header, { inheritedEventCount: inherited })
    try {
      await handle.append(rewritten)
      await handle.flush()
    } finally {
      await handle.close().catch(() => {})
    }
    const attached = await attachSession(workspace, id)
    await this.state.updateSession(workspace.path, id, {
      importedAt: nowIso(),
      sourceMachine: this.state.machineId,
      originCwd: sourceHeader.cwd,
      eventCount: rewritten.length,
      inheritedEventCount: inherited,
      reason: options.reason,
    })
    return {
      id,
      imported: true,
      reason: options.reason,
      eventCount: rewritten.length,
      attached,
      parentSession: typeof sourceHeader.parentSession === 'string' ? sourceHeader.parentSession : undefined,
      origin: sourceHeader.origin === 'subagent' ? 'subagent' : undefined,
      ...(options.newId === undefined ? {} : { sourceId: String(sourceHeader.id) }),
    }
  }

  /**
   * Handle a diverged pair without merging: back up both sides and apply the
   * configured policy.
   * @param {any} workspace - workspace entity.
   * @param {Record<string, unknown>} sourceHeader - snapshot header.
   * @param {readonly Record<string, unknown>[]} events - snapshot events.
   * @param {string} text - snapshot text.
   * @param {Record<string, unknown> | undefined} nativeHeader - native header.
   * @param {readonly Record<string, unknown>[]} nativeEvents - native events.
   * @returns {Promise<Record<string, unknown>>} result.
   */
  async resolveConflict(workspace, sourceHeader, events, text, nativeHeader, nativeEvents) {
    const id = String(sourceHeader.id)
    const stamp = `${Date.now()}-${this.state.machineId}`
    const backupDir = join(workspaceRoot(workspace), '.backup', stamp, id)
    await ensureDir(backupDir)
    await writeTextAtomic(join(backupDir, 'remote.jsonl'), text)
    if (nativeHeader !== undefined && nativeHeader !== null) {
      await writeTextAtomic(join(backupDir, 'native.jsonl'), serializeSnapshot({
        header: snapshotHeader(nativeHeader, nativeHeader.cwd),
        events: nativeEvents,
      }))
    }
    await this.state.addConflict({
      workspace: workspace.path,
      sessionId: id,
      kind: 'diverged',
      policy: this.config.conflictPolicy,
      backup: backupDir,
    })
    if (this.config.conflictPolicy === 'local-wins') {
      return { id, conflict: true, action: 'local-wins', backup: backupDir }
    }
    // `keep-both` and `remote-wins` both preserve the remote branch as a new
    // session: DSH exposes no delete/replace API, so the local log is never
    // destroyed, and the user can pick either openable history.
    const newId = `session-${randomUUID()}`
    const result = await this.recreate(workspace, sourceHeader, events, {
      reason: 'conflict-remote-branch',
      newId,
    })
    return {
      ...result,
      conflict: true,
      action: 'keep-both',
      originalId: id,
      newSessionId: result.id,
      backup: backupDir,
    }
  }
}
