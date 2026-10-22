/**
 * Plugin configuration: defaults, normalization, and the on-disk config file.
 *
 * Configuration lives at `$DSH_HOME/dsh-workspace-session/config.json` so it
 * stays machine-local (paths, timings, and safety switches never travel with a
 * repository). The Settings page edits the same file through the Host API.
 *
 * @module dsh-workspace-session/lib/config
 */

import { dshHomePath, readJsonFile, writeJsonAtomic } from './util.js'

/** Conflict policies accepted by the importer. */
export const CONFLICT_POLICIES = ['keep-both', 'local-wins', 'remote-wins']

/** Default configuration. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  autoExport: true,
  exportDebounceMs: 2000,
  exportMinIntervalMs: 5000,
  exportOnDispose: true,
  exportExistingOnWorkspaceAdd: true,
  autoImportOnStart: true,
  autoImportOnWorkspaceAdd: true,
  importPollMs: 60000,
  conflictPolicy: 'keep-both',
  snapshotMaxBytes: 64 * 1024 * 1024,
  exportBlankSessions: false,
  importBlankSessions: false,
})

/** Configuration file name below the plugin's Harness-home directory. */
export const CONFIG_FILE = 'config.json'

/**
 * @param {unknown} value - candidate.
 * @param {string} field - field name for messages.
 * @returns {boolean} normalized boolean.
 */
function normalizeBoolean(value, field) {
  if (value === undefined) return DEFAULT_CONFIG[field]
  if (typeof value !== 'boolean') throw new Error(`"${field}" must be a boolean`)
  return value
}

/**
 * @param {unknown} value - candidate.
 * @param {string} field - field name for messages.
 * @param {number} min - minimum accepted value.
 * @returns {number} normalized integer.
 */
function normalizeInteger(value, field, min) {
  if (value === undefined) return DEFAULT_CONFIG[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new Error(`"${field}" must be a number >= ${min}`)
  }
  return Math.floor(value)
}

/**
 * Normalize one raw config object into the accepted shape.
 * @param {Record<string, unknown> | undefined} raw - raw file content.
 * @returns {typeof DEFAULT_CONFIG} normalized config.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const conflictPolicy = input.conflictPolicy === undefined
    ? DEFAULT_CONFIG.conflictPolicy
    : input.conflictPolicy
  if (!CONFLICT_POLICIES.includes(conflictPolicy)) {
    throw new Error(`"conflictPolicy" must be one of ${CONFLICT_POLICIES.join(', ')}`)
  }
  return {
    enabled: normalizeBoolean(input.enabled, 'enabled'),
    autoExport: normalizeBoolean(input.autoExport, 'autoExport'),
    exportDebounceMs: normalizeInteger(input.exportDebounceMs, 'exportDebounceMs', 0),
    exportMinIntervalMs: normalizeInteger(input.exportMinIntervalMs, 'exportMinIntervalMs', 0),
    exportOnDispose: normalizeBoolean(input.exportOnDispose, 'exportOnDispose'),
    exportExistingOnWorkspaceAdd: normalizeBoolean(input.exportExistingOnWorkspaceAdd, 'exportExistingOnWorkspaceAdd'),
    autoImportOnStart: normalizeBoolean(input.autoImportOnStart, 'autoImportOnStart'),
    autoImportOnWorkspaceAdd: normalizeBoolean(input.autoImportOnWorkspaceAdd, 'autoImportOnWorkspaceAdd'),
    importPollMs: normalizeInteger(input.importPollMs, 'importPollMs', 0),
    conflictPolicy,
    snapshotMaxBytes: normalizeInteger(input.snapshotMaxBytes, 'snapshotMaxBytes', 1024),
    exportBlankSessions: normalizeBoolean(input.exportBlankSessions, 'exportBlankSessions'),
    importBlankSessions: normalizeBoolean(input.importBlankSessions, 'importBlankSessions'),
  }
}

/** One machine-local configuration store. */
export class ConfigStore {
  /**
   * @param {{ home: string, logger?: { warn?: (message: string) => void } }} options - Harness home and logger.
   */
  constructor(options) {
    this.home = options.home
    this.logger = options.logger
    this.dir = dshHomePath(this.home, 'dsh-workspace-session')
    this.path = dshHomePath(this.dir, CONFIG_FILE)
    this.value = { ...DEFAULT_CONFIG }
  }

  /**
   * Load and validate the config file.
   * @returns {Promise<typeof DEFAULT_CONFIG>} the loaded config.
   */
  async load() {
    const raw = await readJsonFile(this.path, undefined)
    try {
      this.value = normalizeConfig(raw)
    } catch (error) {
      this.logger?.warn?.(`dsh-workspace-session: ignoring invalid config: ${error instanceof Error ? error.message : String(error)}`)
      this.value = { ...DEFAULT_CONFIG }
    }
    return this.value
  }

  /**
   * Merge and persist a patch.
   * @param {Record<string, unknown>} patch - partial config.
   * @returns {Promise<typeof DEFAULT_CONFIG>} the persisted config.
   */
  async update(patch) {
    const next = normalizeConfig({ ...this.value, ...patch })
    this.value = next
    await writeJsonAtomic(this.path, next)
    return next
  }
}
