import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeConfig } from '../lib/config.js'
import { StateStore } from '../lib/state.js'
import { Importer } from '../lib/importer.js'
import { parseSnapshot, serializeSnapshot } from '../lib/snapshot.js'
import { encodeSegment } from '../lib/util.js'
import { event, makeContext, makeWorkspace, MockPersistence, tempDir } from './helpers.js'

const OLD_CWD = '/home/alice/work/proj'

function headerFor(id, cwd = OLD_CWD) {
  return {
    type: 'session',
    version: 4,
    id,
    createdAt: 1700000000000,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
}

async function writeSnapshot(workspacePath, id, cwd, events) {
  const dir = join(workspacePath, '.dsh', 'sessions', encodeSegment(id))
  await mkdir(dir, { recursive: true })
  const text = serializeSnapshot({ header: headerFor(id, cwd), events })
  await writeFile(join(dir, 'session.v4.jsonl'), text, 'utf8')
}

async function makeSetup(options = {}) {
  const workspacePath = options.workspacePath ?? tempDir('ws-')
  const home = tempDir('home-')
  const persistence = options.persistence ?? new MockPersistence()
  const workspace = makeWorkspace(workspacePath)
  const state = new StateStore({ home })
  await state.load()
  const ctx = makeContext({ persistence, workspaces: [workspace] })
  const importer = new Importer(ctx, { config: normalizeConfig({}), state })
  return { workspacePath, home, persistence, workspace, state, importer }
}

test('imports a new snapshot and attaches it to the workspace', async () => {
  const setup = await makeSetup()
  await writeSnapshot(setup.workspacePath, 'session-new', OLD_CWD, [event(0), event(1)])
  const results = await setup.importer.importWorkspace(setup.workspace)
  assert.equal(results.length, 1)
  assert.equal(results[0].imported, true)
  const stored = setup.persistence.sessions.get('session-new')
  assert.ok(stored)
  assert.equal(stored.header.cwd, setup.workspacePath)
  assert.equal(stored.events.length, 2)
  assert.ok(setup.workspace.sessionIds.includes('session-new'))
})

test('rewrites working-directory transitions on import', async () => {
  const setup = await makeSetup()
  await writeSnapshot(setup.workspacePath, 'session-wd', OLD_CWD, [
    { type: 'working-directory/change', seq: 0, time: 1, data: { cwd: OLD_CWD } },
    { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
  ])
  await setup.importer.importWorkspace(setup.workspace)
  const stored = setup.persistence.sessions.get('session-wd')
  assert.equal(stored.events[0].data.cwd, setup.workspacePath)
})

test('fast-forwards a native session by appending the missing suffix', async () => {
  const setup = await makeSetup()
  const wsPath = setup.workspacePath
  setup.persistence.seed(headerFor('session-ff', wsPath), [event(0)])
  await writeSnapshot(wsPath, 'session-ff', OLD_CWD, [event(0), event(1), event(2)])
  const results = await setup.importer.importWorkspace(setup.workspace)
  assert.equal(results[0].reason, 'fast-forward')
  assert.equal(setup.persistence.sessions.get('session-ff').events.length, 3)
})

test('leaves a native-ahead session untouched', async () => {
  const setup = await makeSetup()
  const wsPath = setup.workspacePath
  setup.persistence.seed(headerFor('session-ahead', wsPath), [event(0), event(1), event(2)])
  await writeSnapshot(wsPath, 'session-ahead', OLD_CWD, [event(0)])
  const results = await setup.importer.importWorkspace(setup.workspace)
  assert.equal(results[0].skipped, 'native-ahead')
  assert.equal(setup.persistence.sessions.get('session-ahead').events.length, 3)
})

test('keeps both branches on divergence and records a conflict', async () => {
  const setup = await makeSetup()
  const wsPath = setup.workspacePath
  setup.persistence.seed(headerFor('session-conflict', wsPath), [
    event(0, { turn: 1 }),
    event(1, { marker: 'local' }),
  ])
  await writeSnapshot(wsPath, 'session-conflict', OLD_CWD, [
    event(0, { turn: 1 }),
    event(1, { marker: 'remote' }),
  ])
  const results = await setup.importer.importWorkspace(setup.workspace)
  assert.equal(results[0].conflict, true)
  assert.equal(results[0].action, 'keep-both')
  assert.ok(results[0].newSessionId)
  assert.ok(setup.persistence.sessions.has('session-conflict'))
  assert.ok(setup.persistence.sessions.has(results[0].newSessionId))
  assert.equal(setup.state.data.conflicts.length, 1)
})

test('second scan skips unchanged snapshots', async () => {
  const setup = await makeSetup()
  await writeSnapshot(setup.workspacePath, 'session-once', OLD_CWD, [event(0)])
  await setup.importer.importWorkspace(setup.workspace)
  const second = await setup.importer.importWorkspace(setup.workspace)
  assert.equal(second.length, 0)
})

test('imported snapshot content is readable through the mock store', async () => {
  const setup = await makeSetup()
  await writeSnapshot(setup.workspacePath, 'session-read', OLD_CWD, [event(0), event(1)])
  await setup.importer.importWorkspace(setup.workspace)
  const handle = await setup.persistence.open('session-read', 'read')
  const read = await handle.read(0)
  assert.equal(read.events.length, 2)
  await handle.close()
  const text = await readFile(join(setup.workspacePath, '.dsh', 'sessions', encodeSegment('session-read'), 'session.v4.jsonl'), 'utf8')
  assert.equal(parseSnapshot(text).header.id, 'session-read')
})
