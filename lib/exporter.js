/**
 * Exporter: native session log → workspace text snapshot.
 *
 * Reads a stored session through the public `SessionHandle` API and writes a
 * git-friendly JSONL snapshot below `<workspace>/.dsh/sessions/<id>/`.
 * The snapshot header keeps the session's original `cwd` (`originCwd`) so
 * another machine can remap it on import.
 *
 * @module dsh-workspace-session/lib/exporter
 */

import {
  snapshotPath, snapshotHeader, serializeSnapshot, lastEventFingerprint,
  readSnapshotHeader, trimTrailingResumeMarker, isBlankSession,
} from './snapshot.js'
import { WorkspaceIndex } from './state.js'
import { encodeSegment, nowIso, realpathDirectory, statOrUndefined, writeTextAtomic } from './util.js'

/** Exports sessions owned by one workspace. */
export class Exporter {
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
   * Export one session.
   * @param {any} workspace - workspace entity.
   * @param {string} sessionId - session id.
   * @param {{ force?: boolean, snapshot?: any }} [options] - force a write, or reuse a known stat snapshot.
   * @returns {Promise<Record<string, unknown>>} result summary.
   */
  async exportSession(workspace, sessionId, options = {}) {
    const persistence = this.ctx.sessionPersistence
    if (persistence === undefined || persistence === null) return { id: sessionId, skipped: 'no-persistence' }
    const stat = options.snapshot ?? await persistence.stat(sessionId)
    if (stat === undefined || stat === null) return { id: sessionId, skipped: 'missing' }
    const index = new WorkspaceIndex(workspace.path)
    await index.load()
    const record = index.session(sessionId)
    const target = snapshotPath(workspace.path, sessionId)
    // Resolution order: the machine-local index, then the existing snapshot
    // header, then the native header. The snapshot fallback keeps originCwd
    // stable even when the index file is gitignored or was deleted.
    const existingHeader = await readSnapshotHeader(target)
    const originCwd = typeof record?.originCwd === 'string' && record.originCwd !== ''
      ? record.originCwd
      : (typeof existingHeader?.cwd === 'string' && existingHeader.cwd !== ''
          ? existingHeader.cwd
          : stat.header?.cwd)
    if (typeof originCwd !== 'string' || originCwd === '') return { id: sessionId, skipped: 'no-cwd' }
    // Fast path: the native log has not changed since the last export. The
    // indexed native count includes the trailing resume markers this exporter
    // drops from the snapshot, so it compares against that count rather than
    // the snapshot's own event count.
    if (options.force !== true && typeof stat.eventCount === 'number'
      && record?.nativeEventCount === stat.eventCount
      && await statOrUndefined(target) !== undefined) {
      return { id: sessionId, skipped: 'unchanged', eventCount: record.eventCount }
    }

    let handle
    try {
      handle = await persistence.open(sessionId, 'read')
      const read = await handle.read(0)
      // A trailing plain `session/end-seed` is a resume boundary, not content:
      // drop it so merely opening a session never creates a git diff.
      const events = trimTrailingResumeMarker(read.events)
      const eventCount = events.length
      if (this.config.exportBlankSessions !== true && isBlankSession(events)) {
        return { id: sessionId, skipped: 'blank', eventCount }
      }
      const header = snapshotHeader(handle.header, originCwd)
      const text = serializeSnapshot({ header, events })
      await writeTextAtomic(target, text, { mode: 0o600 })
      // Record the snapshot mtime so the importer's periodic scan does not
      // re-read a file this process just wrote.
      const workspaceRecord = this.state.workspace(workspace.path)
      workspaceRecord.dirs ??= {}
      const written = await statOrUndefined(target)
      if (written !== undefined) workspaceRecord.dirs[encodeSegment(sessionId)] = written.mtimeMs
      await index.update(sessionId, {
        originCwd,
        eventCount,
        nativeEventCount: stat.eventCount,
        lastEventHash: lastEventFingerprint(events),
        exportedAt: nowIso(),
        lastWriter: this.state.machineId,
      })
      await this.state.updateSession(workspace.path, sessionId, {
        originCwd,
        eventCount,
        lastExportedAt: nowIso(),
      })
      return { id: sessionId, exported: true, eventCount, path: target }
    } catch (error) {
      this.logger?.warn?.(`dsh-workspace-session: export of "${sessionId}" failed: ${error instanceof Error ? error.message : String(error)}`)
      return { id: sessionId, error: error instanceof Error ? error.message : String(error) }
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  /**
   * Export every stored session whose recorded cwd is this workspace.
   * @param {any} workspace - workspace entity.
   * @param {{ force?: boolean }} [options] - force writes.
   * @returns {Promise<Record<string, unknown>[]>} per-session results.
   */
  async exportWorkspace(workspace, options = {}) {
    const persistence = this.ctx.sessionPersistence
    if (persistence === undefined || persistence === null) return []
    const canonicalWorkspace = await realpathDirectory(workspace.path) ?? workspace.path
    let snapshots
    try {
      snapshots = await persistence.list()
    } catch (error) {
      this.logger?.warn?.(`dsh-workspace-session: cannot list sessions for export: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
    const results = []
    for (const snapshot of snapshots) {
      const cwd = snapshot?.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') continue
      const canonicalCwd = await realpathDirectory(cwd)
      if (canonicalCwd !== canonicalWorkspace) continue
      results.push(await this.exportSession(workspace, snapshot.header.id, { ...options, snapshot }))
    }
    return results
  }

  /**
   * Export one session only when it belongs to a workspace.
   * @param {string} sessionId - session id.
   * @param {string | undefined} cwd - the session's recorded cwd.
   * @param {{ force?: boolean }} [options] - force a write.
   * @returns {Promise<Record<string, unknown>>} result summary.
   */
  async exportLiveSession(sessionId, cwd, options = {}) {
    const { findWorkspaceForCwd } = await import('./workspace.js')
    const workspace = await findWorkspaceForCwd(this.ctx, cwd)
    if (workspace === undefined) return { id: sessionId, skipped: 'ungrouped' }
    return this.exportSession(workspace, sessionId, options)
  }
}
