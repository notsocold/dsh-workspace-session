/**
 * Host HTTP API for the browser half.
 *
 * Routes are registered through `ctx.connection.fetch`, so they live inside
 * the authenticated `/api` fence: only the page's owner peer reaches them.
 * The browser uses plain `fetch`; no generated Remote client is required.
 *
 * @module dsh-workspace-session/lib/api
 */

import { errorPayload, isRecord } from './util.js'

/** Shared path prefix of every route. */
export const API_PREFIX = '/api/dsh-workspace-session'

/**
 * @param {unknown} value - success payload.
 * @returns {Response} JSON response.
 */
function ok(value) {
  return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
}

/**
 * @param {unknown} error - thrown value.
 * @returns {Response} JSON error response.
 */
function failure(error) {
  const payload = errorPayload(error)
  return Response.json(
    { ok: false, error: payload },
    { status: payload.code === 'invalid-request' ? 400 : 500, headers: { 'cache-control': 'no-store' } },
  )
}

/**
 * Build the route list for one sync coordinator.
 * @param {{ syncer: import('./sync.js').Syncer, configStore: any }} services - plugin services.
 * @returns {Array<Record<string, unknown>>} fetch routes.
 */
export function apiRoutes(services) {
  const { syncer, configStore } = services
  return [
    {
      path: `${API_PREFIX}/state`,
      methods: /** @type {const} */ (['GET']),
      requestBody: 'buffered',
      async fetch() {
        try {
          return ok(await syncer.status())
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      path: `${API_PREFIX}/action`,
      methods: /** @type {const} */ (['POST']),
      requestBody: 'buffered',
      async fetch(request) {
        let body
        try {
          body = await request.json()
        } catch {
          return failure(Object.assign(new Error('request body must be a JSON object'), { code: 'invalid-request' }))
        }
        if (!isRecord(body)) {
          return failure(Object.assign(new Error('request body must be a JSON object'), { code: 'invalid-request' }))
        }
        try {
          switch (body.action) {
            case 'sync':
              return ok({ action: 'sync', results: await syncer.syncNow({ force: body.force === true }) })
            case 'import':
              return ok({ action: 'import', results: await syncer.importAll({ force: body.force === true }) })
            case 'export':
              return ok({ action: 'export', results: await syncer.exportAll({ force: body.force === true }) })
            case 'config': {
              if (!isRecord(body.patch)) {
                throw Object.assign(new Error('"patch" must be an object'), { code: 'invalid-request' })
              }
              const config = await configStore.update(body.patch)
              syncer.refreshConfig()
              syncer.reconfigure()
              return ok({ action: 'config', config })
            }
            case 'status':
              return ok({ action: 'status', status: await syncer.status() })
            default:
              throw Object.assign(new Error(`unknown action "${String(body.action)}"`), { code: 'invalid-request' })
          }
        } catch (error) {
          return failure(error)
        }
      },
    },
  ]
}

/**
 * Register the routes while a `connection` service exists.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {{ syncer: import('./sync.js').Syncer, configStore: any }} services - plugin services.
 */
export function registerApi(ctx, services) {
  ctx.inject(['connection'], (scoped) => {
    scoped.effect(async () => {
      const disposers = []
      try {
        for (const route of apiRoutes(services)) {
          disposers.push(await scoped.connection.fetch.register(route))
        }
      } catch (error) {
        for (const dispose of disposers) {
          try {
            await dispose()
          } catch {
            // Rollback only.
          }
        }
        throw error
      }
      return async () => {
        for (const dispose of disposers) {
          try {
            await dispose()
          } catch {
            // Teardown is best-effort.
          }
        }
      }
    }, 'dsh-workspace-session: http routes')
  })
}
