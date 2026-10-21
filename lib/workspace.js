/**
 * Workspace discovery and membership helpers.
 *
 * The DSH workspace registry is the only authority for which sessions belong
 * to which workspace. This module reads that registry, maps a session's
 * recorded cwd to a workspace (canonical path equality), and attaches imported
 * sessions back to their workspace.
 *
 * @module dsh-workspace-session/lib/workspace
 */

import { realpathDirectory } from './util.js'
import { join } from 'node:path'

/**
 * List every registered workspace.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {any[]} workspace entities.
 */
export function listWorkspaces(ctx) {
  try {
    const registry = ctx.workspaceRegistry
    if (registry === undefined || registry === null) return []
    return registry.list()
  } catch {
    return []
  }
}

/**
 * Resolve the workspace that owns one directory, by canonical path equality.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string | undefined} cwd - session working directory.
 * @returns {Promise<any | undefined>} matching workspace.
 */
export async function findWorkspaceForCwd(ctx, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return undefined
  const canonical = await realpathDirectory(cwd)
  if (canonical === undefined) return undefined
  for (const workspace of listWorkspaces(ctx)) {
    const path = workspace?.path
    if (typeof path !== 'string') continue
    const workspaceCanonical = await realpathDirectory(path)
    if (workspaceCanonical === canonical) return workspace
  }
  return undefined
}

/**
 * Workspace session root: `<workspace>/.dsh/sessions`.
 * @param {{ path: string }} workspace - workspace entity.
 * @returns {string} absolute root.
 */
export function workspaceRoot(workspace) {
  return join(workspace.path, '.dsh', 'sessions')
}

/**
 * Workspace sync index file.
 * @param {{ path: string }} workspace - workspace entity.
 * @returns {string} absolute path.
 */
export function workspaceIndexPath(workspace) {
  return join(workspace.path, '.dsh', 'workspace-session.json')
}

/**
 * Attach one session to a workspace.
 * @param {any} workspace - workspace entity.
 * @param {string} sessionId - session id.
 * @returns {Promise<boolean>} true when the registry accepted the attach.
 */
export async function attachSession(workspace, sessionId) {
  if (workspace === null || workspace === undefined || typeof workspace.attachSession !== 'function') return false
  try {
    await workspace.attachSession(sessionId)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a workspace already accounts for a session.
 * @param {any} workspace - workspace entity.
 * @param {string} sessionId - session id.
 * @returns {boolean} true when the id is already in the account.
 */
export function accountsFor(workspace, sessionId) {
  try {
    return Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(sessionId)
  } catch {
    return false
  }
}

/**
 * Human-readable workspace label.
 * @param {any} workspace - workspace entity.
 * @returns {string} display title.
 */
export function workspaceLabel(workspace) {
  try {
    if (typeof workspace?.title === 'string' && workspace.title !== '') return workspace.title
  } catch {
    // Fall through to the path.
  }
  return typeof workspace?.path === 'string' ? workspace.path : 'workspace'
}
