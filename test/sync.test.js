import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../lib/config.js'
import { StateStore } from '../lib/state.js'
import { Syncer } from '../lib/sync.js'
import { makeContext, makeWorkspace, tempDir } from './helpers.js'

async function makeSyncer() {
  const events = []
  const ctx = {
    ...makeContext({ workspaces: [] }),
    emit(name, payload) { events.push({ name, payload }) },
  }
  const configStore = { value: normalizeConfig({}) }
  const state = new StateStore({ home: tempDir('home-') })
  await state.load()
  const syncer = new Syncer(ctx, { configStore, state })
  return { syncer, events }
}

test('publishAdded announces an imported session on the official list feed', async () => {
  const { syncer, events } = await makeSyncer()
  const workspace = makeWorkspace('/home/bob/work/proj')
  syncer.publishAdded(workspace, {
    id: 'session-imported',
    eventCount: 4,
    parentSession: 'session-parent',
    origin: 'subagent',
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].name, 'api-session/added')
  assert.equal(events[0].payload.sessionId, 'session-imported')
  assert.equal(events[0].payload.cwd, workspace.path)
  assert.equal(events[0].payload.running, false)
  assert.equal(events[0].payload.blank, false)
  assert.equal(events[0].payload.parentSessionId, 'session-parent')
  assert.equal(events[0].payload.origin, 'subagent')
})

test('publishAdded survives a composition without the list feed', async () => {
  const { syncer } = await makeSyncer()
  const ctx = syncer.ctx
  ctx.emit = () => { throw new Error('no event feed') }
  assert.doesNotThrow(() => syncer.publishAdded(makeWorkspace('/ws'), { id: 's', eventCount: 0 }))
})
