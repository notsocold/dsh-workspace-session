/**
 * Keep a workspace's `.gitignore` aligned with the plugin's on-disk layout.
 *
 * The snapshot directory is meant to travel with the repository, but the
 * machine-local index, lock files, conflict backups, and transient `.tmp`
 * writes must not. This module appends the missing rules once and reports
 * whether the machine-local index is still tracked by git (which gitignore
 * cannot fix for an already-tracked file).
 *
 * It never runs `git rm --cached`: changing the git index is a deliberate
 * user action, so the plugin only reports the situation.
 *
 * @module dsh-workspace-session/lib/gitignore
 */

import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { writeTextAtomic } from './util.js'

const execFileAsync = promisify(execFile)

/** Rules the plugin needs in a workspace `.gitignore`. */
export const GITIGNORE_PATTERNS = Object.freeze([
  '.dsh/workspace-session.json',
  '.dsh/sessions/**/session.lock',
  '.dsh/sessions/**/*.tmp',
  '.dsh/sessions/.backup/',
])

/** Marker line for the block this plugin owns. */
const GITIGNORE_MARKER = '# DSH workspace-session (managed by dsh-workspace-session)'

/**
 * Ensure the workspace `.gitignore` contains every plugin rule.
 *
 * Existing content is preserved; only missing patterns are appended, so the
 * operation is idempotent and never removes user rules.
 *
 * @param {string} workspacePath - workspace directory.
 * @returns {Promise<{ path: string, changed: boolean, missing: string[] }>} result.
 */
export async function ensureGitignore(workspacePath) {
  const path = join(workspacePath, '.gitignore')
  let text = ''
  let mode = 0o644
  try {
    text = await readFile(path, 'utf8')
    mode = (await stat(path)).mode & 0o777
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const existing = new Set(text.split('\n').map(line => line.trim()))
  const missing = GITIGNORE_PATTERNS.filter(pattern => !existing.has(pattern))
  if (missing.length === 0) return { path, changed: false, missing: [] }

  const block = [GITIGNORE_MARKER, ...missing].join('\n')
  let next
  if (text === '') next = block + '\n'
  else if (text.endsWith('\n')) next = text + '\n' + block + '\n'
  else next = text + '\n\n' + block + '\n'
  await writeTextAtomic(path, next, { mode })
  return { path, changed: true, missing }
}

/**
 * Whether a directory is inside a git working tree.
 * @param {string} workspacePath - workspace directory.
 * @returns {Promise<boolean>} true when git recognizes a working tree.
 */
export async function isGitRepository(workspacePath) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspacePath, 'rev-parse', '--is-inside-work-tree'], {
      timeout: 3000,
    })
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Whether git currently tracks a path in the workspace repository.
 *
 * A `false` result also covers "not a git repository" and a missing git
 * executable; the caller treats those as nothing to report.
 *
 * @param {string} workspacePath - workspace directory.
 * @param {string} relativePath - repository-relative path.
 * @returns {Promise<boolean>} true when the path is tracked.
 */
export async function gitTracksPath(workspacePath, relativePath) {
  try {
    await execFileAsync('git', ['-C', workspacePath, 'ls-files', '--error-unmatch', relativePath], {
      timeout: 3000,
    })
    return true
  } catch {
    return false
  }
}
