/**
 * Test helpers: temporary directories and in-memory persistence/workspace
 * stand-ins shaped like the real Cordis services.
 *
 * @module dsh-workspace-session/test/helpers
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** @returns {string} a fresh temporary directory. */
export function tempDir(prefix = 'dws-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * @param {string} path - workspace directory.
 * @param {string} [title] - display title.
 * @returns {any} a workspace stand-in with `attachSession`.
 */
export function makeWorkspace(path, title = 'ws') {
  return {
    path,
    title,
    sessionIds: [],
    async attachSession(id) {
      if (!this.sessionIds.includes(id)) this.sessionIds.push(id)
    },
  }
}

/** One in-memory stored session. */
class MockHandle {
  constructor(store, id, access, inheritedEventCount = 0) {
    this.store = store
    this.id = id
    this.access = access
    this.inheritedEventCount = inheritedEventCount
    this.closed = false
  }

  get header() {
    return this.store.sessions.get(this.id).header
  }

  async read(offset = 0, length) {
    const events = this.store.sessions.get(this.id).events
    return {
      eventState: 'detached',
      events: events.slice(offset, length === undefined ? undefined : offset + length),
    }
  }

  async append(events) {
    if (this.access !== 'write') throw new Error('read-only handle')
    this.store.sessions.get(this.id).events.push(...events)
  }

  async flush() {}

  async close() {
    this.closed = true
  }
}

/** In-memory `ctx.sessionPersistence` stand-in. */
export class MockPersistence {
  constructor() {
    /** @type {Map<string, { header: Record<string, any>, events: Record<string, any>[], inheritedEventCount: number }>} */
    this.sessions = new Map()
    this.createCalls = 0
  }

  /**
   * Seed one stored session.
   * @param {Record<string, any>} header - session header.
   * @param {Record<string, any>[]} events - session events.
   * @param {number} [inheritedEventCount] - fork-inherited prefix length.
   */
  seed(header, events, inheritedEventCount = 0) {
    const normalized = { ...header, delegationDepth: header.delegationDepth ?? 0 }
    this.sessions.set(header.id, { header: normalized, events: [...events], inheritedEventCount })
  }

  async list() {
    return [...this.sessions.entries()].map(([id, value]) => ({
      header: { ...value.header },
      revision: `rev-${value.events.length}`,
      eventCount: value.events.length,
    }))
  }

  async stat(id) {
    const value = this.sessions.get(id)
    if (value === undefined) return undefined
    return { header: { ...value.header }, revision: `rev-${value.events.length}`, eventCount: value.events.length }
  }

  async create(header, options = {}) {
    if (this.sessions.has(header.id)) throw new Error(`session "${header.id}" already exists`)
    this.createCalls += 1
    this.sessions.set(header.id, {
      header: { ...header, delegationDepth: header.delegationDepth ?? 0 },
      events: [],
      inheritedEventCount: options.inheritedEventCount ?? 0,
    })
    return new MockHandle(this, header.id, 'write', options.inheritedEventCount ?? 0)
  }

  async open(id, access) {
    const value = this.sessions.get(id)
    if (value === undefined) throw new Error(`session "${id}" not found`)
    return new MockHandle(this, id, access, value.inheritedEventCount)
  }

  async flush() {}
}

/**
 * Build a Cordis-like context around the mocks.
 * @param {{ persistence?: MockPersistence, workspaces?: any[] }} [options] - overrides.
 * @returns {any} fake context.
 */
export function makeContext(options = {}) {
  const persistence = options.persistence ?? new MockPersistence()
  const workspaces = options.workspaces ?? []
  return {
    sessionPersistence: persistence,
    workspaceRegistry: {
      list: () => workspaces,
    },
    get(name) {
      if (name === 'sessionPersistence') return persistence
      if (name === 'workspaceRegistry') return this.workspaceRegistry
      if (name === 'sessions') return { list: () => [] }
      return undefined
    },
    logger: { warn() {}, info() {} },
  }
}

/**
 * @param {number} seq - event sequence number.
 * @param {Record<string, any>} [data] - event data.
 * @param {string} [type] - event type.
 * @returns {Record<string, any>} a minimal session event.
 */
export function event(seq, data = {}, type = 'turn/start') {
  return { type, seq, time: 1000 + seq, data }
}
