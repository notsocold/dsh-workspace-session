/**
 * Sync coordinator: wires session events, workspace discovery, the exporter,
 * and the importer together.
 *
 * Triggers:
 * - export: `session/flush` (debounced), `session/disposed`, startup
 *   reconciliation, the periodic sweep, and manual sync;
 * - import: startup, a new workspace (`domain/changed`), the periodic sweep,
 *   and manual sync.
 *
 * @module dsh-workspace-session/lib/sync
 */

import { readdir } from 'node:fs/promises'
import { Exporter } from './exporter.js'
import { Importer } from './importer.js'
import { listWorkspaces, findWorkspaceForCwd, workspaceRoot, workspaceLabel } from './workspace.js'
import { nowIso, sleep } from './util.js'

/** Delay before a disposed session's final export, letting the backend close. */
const DISPOSE_SETTLE_MS = 60

/** Default manual sweep limit per workspace, to bound a single request. */
const STATUS_LIST_LIMIT = 200

/**
 * @param {unknown} input - an event payload or the session itself.
 * @returns {any} the session.
 */
function sessionOf(input) {
  return input?.session ?? input
}

/** Coordinates exports and imports for every registered workspace. */
export class Syncer {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
   * @param {{ configStore: any, state: any, logger?: { warn?: (message: string) => void } }} options - plugin services.
   */
  constructor(ctx, options) {
    this.ctx = ctx
    this.configStore = options.configStore
    this.state = options.state
    this.logger = options.logger
    this.exporter = new Exporter(ctx, {
      config: this.configStore.value,
      state: options.state,
      logger: options.logger,
    })
    this.importer = new Importer(ctx, {
      config: this.configStore.value,
      state: options.state,
      logger: options.logger,
    })
    /** @type {Map<string, { id: string, cwd?: string }>} */
    this.dirty = new Map()
    this.exportTimer = undefined
    this.pollTimer = undefined
    this.running = false
    this.started = false
    this.lastSweepAt = undefined
    /** @type {any[]} */
    this.lastResults = []
  }

  /** Current configuration object (mutable by the Settings page). */
  get config() {
    return this.configStore.value
  }

  /** Start listeners and schedule the first reconciliation. */
  start() {
    if (this.started) return
    this.started = true
    this.ctx.on('session/flush', (input) => { this.onFlush(input) })
    this.ctx.on('session/disposed', (input) => { void this.onDisposed(input) })
    this.ctx.on('domain/changed', (change) => { void this.onDomainChanged(change) })
    this.installPoll()
    // Defer the initial sweep so plugin loading is never blocked by file I/O.
    setTimeout(() => { void this.reconcile({ reason: 'startup' }) }, 500)
  }

  /** Stop timers. Event listeners are owned by the plugin fiber. */
  stop() {
    if (this.exportTimer !== undefined) {
      clearTimeout(this.exportTimer)
      this.exportTimer = undefined
    }
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  /** Reinstall the periodic sweep after a config change. */
  reconfigure() {
    this.installPoll()
  }

  /** Install the periodic sweep when configured. */
  installPoll() {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    const interval = this.config.importPollMs
    if (this.config.enabled && Number.isFinite(interval) && interval > 0) {
      this.pollTimer = setInterval(() => { void this.poll() }, interval)
      this.pollTimer.unref?.()
    }
  }

  /**
   * @param {unknown} input - session/flush payload.
   */
  onFlush(input) {
    const session = sessionOf(input)
    if (session === undefined || session === null) return
    if (!this.config.enabled || !this.config.autoExport) return
    const cwd = session.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return
    this.dirty.set(String(session.id), { id: String(session.id), cwd })
    this.scheduleExportTimer()
  }

  /**
   * @param {unknown} input - session/disposed payload.
   */
  async onDisposed(input) {
    const session = sessionOf(input)
    if (session === undefined || session === null) return
    if (!this.config.enabled || !this.config.exportOnDispose) return
    const cwd = session.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return
    await sleep(DISPOSE_SETTLE_MS)
    try {
      await this.exportByCwd(String(session.id), cwd)
    } catch (error) {
      this.logger?.warn?.(`dsh-workspace-session: final export failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * @param {any} change - domain/changed payload.
   */
  async onDomainChanged(change) {
    if (change?.domain !== 'workspace' || change?.table !== 'workspaces') return
    if (!this.config.enabled) return
    if (change.operation === 'deleted') return
    const path = change.value?.path
    if (typeof path !== 'string' || path === '') return
    setTimeout(() => { void this.reconcileWorkspacePath(path, { reason: 'workspace-added' }) }, 200)
  }

  /** Copy the latest config into the worker classes after a Settings edit. */
  refreshConfig() {
    this.exporter.config = this.config
    this.importer.config = this.config
  }

  /** Schedule one debounced export sweep. */
  scheduleExportTimer() {
    if (this.exportTimer !== undefined) return
    const delay = Math.max(0, this.config.exportDebounceMs)
    this.exportTimer = setTimeout(() => {
      this.exportTimer = undefined
      void this.flushDirty()
    }, delay)
    this.exportTimer.unref?.()
  }

  /** Export every dirty session. */
  async flushDirty() {
    if (this.running) {
      this.scheduleExportTimer()
      return
    }
    if (!this.config.enabled || !this.config.autoExport) {
      this.dirty.clear()
      return
    }
    this.running = true
    this.refreshConfig()
    const entries = [...this.dirty.values()]
    this.dirty.clear()
    try {
      for (const entry of entries) {
        await this.exportByCwd(entry.id, entry.cwd, { throttle: true })
      }
    } finally {
      this.running = false
    }
  }

  /**
   * Export one session by resolving its workspace from the recorded cwd.
   * @param {string} id - session id.
   * @param {string | undefined} cwd - recorded working directory.
   * @param {{ throttle?: boolean }} [options] - skip when exported too recently.
   * @returns {Promise<Record<string, unknown>>} result.
   */
  async exportByCwd(id, cwd, options = {}) {
    const workspace = await findWorkspaceForCwd(this.ctx, cwd)
    if (workspace === undefined) return { id, skipped: 'ungrouped' }
    return this.exporter.exportSession(workspace, id, { force: false })
  }

  /**
   * Reconcile every registered workspace: import snapshots, then export
   * sessions that belong to the workspace.
   * @param {{ reason?: string, force?: boolean }} [options] - sweep options.
   * @returns {Promise<any[]>} per-workspace results.
   */
  async reconcile(options = {}) {
    if (!this.config.enabled) return []
    const workspaces = listWorkspaces(this.ctx)
    const results = []
    for (const workspace of workspaces) {
      try {
        results.push({ workspace: workspace.path, ...await this.reconcileOne(workspace, options) })
      } catch (error) {
        results.push({ workspace: workspace.path, error: error instanceof Error ? error.message : String(error) })
      }
    }
    this.lastSweepAt = nowIso()
    this.lastResults = results
    return results
  }

  /**
   * @param {string} path - workspace path from `domain/changed`.
   * @param {{ reason?: string, force?: boolean }} [options] - sweep options.
   * @returns {Promise<any | undefined>} result.
   */
  async reconcileWorkspacePath(path, options = {}) {
    const workspace = listWorkspaces(this.ctx).find(candidate => candidate?.path === path)
    if (workspace === undefined) return undefined
    return this.reconcileOne(workspace, options)
  }

  /**
   * @param {any} workspace - workspace entity.
   * @param {{ reason?: string, force?: boolean }} [options] - sweep options.
   * @returns {Promise<{ imported: any[], exported: any[] }>} results.
   */
  async reconcileOne(workspace, options = {}) {
    this.refreshConfig()
    const shouldImport = options.force === true
      || this.config.autoImportOnStart
      || (options.reason === 'poll' && this.config.importPollMs > 0)
    const imported = shouldImport
      ? await this.importer.importWorkspace(workspace, { force: options.force })
      : []
    const exported = this.config.autoExport || options.force === true
      ? await this.exporter.exportWorkspace(workspace, { force: false })
      : []
    for (const result of imported) {
      if (result?.imported === true) this.publishAdded(workspace, result)
    }
    return { imported, exported }
  }

  /**
   * Announce one imported session on the Host's list feed so an already-open
   * Client inserts the row without a page reload. The official
   * `api-session/added` event is forwarded to the browser and merged by the
   * session list model; the workspace follow stream already carries the
   * attached id.
   * @param {any} workspace - workspace entity.
   * @param {Record<string, unknown>} result - importer result.
   */
  publishAdded(workspace, result) {
    try {
      this.ctx.emit('api-session/added', {
        sessionId: result.id,
        updatedAt: Date.now(),
        running: false,
        blank: result.eventCount === 0,
        cwd: workspace.path,
        ...(result.parentSession === undefined ? {} : { parentSessionId: result.parentSession }),
        ...(result.origin === undefined ? {} : { origin: result.origin }),
        agentAvailable: false,
        formatStatus: 'current',
      })
    } catch {
      // The event feed is optional (headless compositions may not mount it).
    }
  }

  /** Periodic sweep: import changed snapshots and export live sessions. */
  async poll() {
    if (!this.config.enabled) return
    try {
      await this.reconcile({ reason: 'poll' })
      await this.flushLiveSessions()
    } catch (error) {
      this.logger?.warn?.(`dsh-workspace-session: periodic sweep failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Export live sessions that belong to a workspace (crash/debounce safety net). */
  async flushLiveSessions() {
    if (!this.config.autoExport) return
    let sessions
    try {
      sessions = this.ctx.get('sessions')?.list() ?? []
    } catch {
      return
    }
    for (const session of sessions) {
      const cwd = session?.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') continue
      try {
        await this.exportByCwd(String(session.id), cwd)
      } catch {
        // Best-effort safety net.
      }
    }
  }

  /**
   * Manual full sync: import then export every workspace.
   * @param {{ force?: boolean }} [options] - force rescan and rewrite.
   * @returns {Promise<any[]>} per-workspace results.
   */
  async syncNow(options = {}) {
    return this.reconcile({ reason: 'manual', force: options.force === true })
  }

  /**
   * Manual import only.
   * @param {{ force?: boolean }} [options] - force rescan.
   * @returns {Promise<any[]>} per-workspace imported results.
   */
  async importAll(options = {}) {
    const workspaces = listWorkspaces(this.ctx)
    const results = []
    this.refreshConfig()
    for (const workspace of workspaces) {
      const imported = await this.importer.importWorkspace(workspace, { force: options.force === true })
      results.push({ workspace: workspace.path, imported })
    }
    return results
  }

  /**
   * Manual export only.
   * @param {{ force?: boolean }} [options] - force rewrite.
   * @returns {Promise<any[]>} per-workspace exported results.
   */
  async exportAll(options = {}) {
    const workspaces = listWorkspaces(this.ctx)
    const results = []
    this.refreshConfig()
    for (const workspace of workspaces) {
      const exported = await this.exporter.exportWorkspace(workspace, { force: options.force === true })
      results.push({ workspace: workspace.path, exported })
    }
    return results
  }

  /**
   * Status payload for the Settings page.
   * @returns {Promise<Record<string, unknown>>} status.
   */
  async status() {
    const workspaces = listWorkspaces(this.ctx)
    const rows = []
    for (const workspace of workspaces.slice(0, STATUS_LIST_LIMIT)) {
      const root = workspaceRoot(workspace)
      let snapshots = 0
      try {
        const entries = await readdir(root, { withFileTypes: true })
        snapshots = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).length
      } catch {
        // A workspace without synced sessions has no root yet.
      }
      const record = this.state.workspace(workspace.path)
      rows.push({
        path: workspace.path,
        title: workspaceLabel(workspace),
        root,
        snapshots,
        importedSessions: Object.keys(record.sessions ?? {}).length,
        lastScanAt: record.lastScanAt,
        sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0,
      })
    }
    return {
      enabled: this.config.enabled,
      machineId: this.state.machineId,
      config: this.config,
      workspaces: rows,
      conflicts: (this.state.data.conflicts ?? []).slice(0, 20),
      lastSweepAt: this.lastSweepAt,
      pendingExports: this.dirty.size,
    }
  }
}
