import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeConfig } from '../lib/config.js'
import { StateStore } from '../lib/state.js'
import { Exporter } from '../lib/exporter.js'
import { parseSnapshot, snapshotPath } from '../lib/snapshot.js'
import { event, makeContext, makeWorkspace, MockPersistence, tempDir } from './helpers.js'

const OTHER_CWD = '/home/alice/work/other'

function headerFor(id, cwd) {
  return {
    version: 4,
    id,
    createdAt: 1700000000000,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
}

async function makeSetup() {
  const workspacePath = tempDir('ws-')
  const home = tempDir('home-')
  const persistence = new MockPersistence()
  const workspace = makeWorkspace(workspacePath)
  const state = new StateStore({ home })
  await state.load()
  const ctx = makeContext({ persistence, workspaces: [workspace] })
  const exporter = new Exporter(ctx, { config: normalizeConfig({}), state })
  return { workspacePath, persistence, workspace, state, exporter }
}

test('exports a workspace session as a text snapshot', async () => {
  const setup = await makeSetup()
  setup.persistence.seed(headerFor('session-export', setup.workspacePath), [event(0), event(1)])
  const result = await setup.exporter.exportSession(setup.workspace, 'session-export')
  assert.equal(result.exported, true)
  const text = await readFile(snapshotPath(setup.workspacePath, 'session-export'), 'utf8')
  const parsed = parseSnapshot(text)
  assert.equal(parsed.header.id, 'session-export')
  assert.equal(parsed.header.cwd, setup.workspacePath)
  assert.equal(parsed.events.length, 2)
})

test('keeps originCwd stable across repeated exports', async () => {
  const setup = await makeSetup()
  setup.persistence.seed(headerFor('session-origin', '/original/machine/proj'), [event(0)])
  setup.persistence.sessions.get('session-origin').header.cwd = setup.workspacePath
  await setup.exporter.exportSession(setup.workspace, 'session-origin')
  // Simulate a later native header whose cwd is this machine: the index keeps
  // the original path from the first export.
  const text = await readFile(snapshotPath(setup.workspacePath, 'session-origin'), 'utf8')
  assert.equal(parseSnapshot(text).header.cwd, setup.workspacePath)
  setup.persistence.sessions.get('session-origin').events.push(event(1))
  await setup.exporter.exportSession(setup.workspace, 'session-origin')
  const text2 = await readFile(snapshotPath(setup.workspacePath, 'session-origin'), 'utf8')
  assert.equal(parseSnapshot(text2).header.cwd, setup.workspacePath)
})

test('exports only sessions whose recorded cwd is the workspace', async () => {
  const setup = await makeSetup()
  setup.persistence.seed(headerFor('session-in', setup.workspacePath), [event(0)])
  setup.persistence.seed(headerFor('session-out', OTHER_CWD), [event(0)])
  const results = await setup.exporter.exportWorkspace(setup.workspace)
  assert.equal(results.length, 1)
  assert.equal(results[0].id, 'session-in')
  await assert.rejects(readFile(snapshotPath(setup.workspacePath, 'session-out'), 'utf8'))
})

test('skips an unchanged session unless forced', async () => {
  const setup = await makeSetup()
  setup.persistence.seed(headerFor('session-skip', setup.workspacePath), [event(0)])
  await setup.exporter.exportSession(setup.workspace, 'session-skip')
  const second = await setup.exporter.exportSession(setup.workspace, 'session-skip')
  assert.equal(second.skipped, 'unchanged')
  const forced = await setup.exporter.exportSession(setup.workspace, 'session-skip', { force: true })
  assert.equal(forced.exported, true)
})

test('unknown sessions are skipped without error', async () => {
  const setup = await makeSetup()
  const result = await setup.exporter.exportSession(setup.workspace, 'session-missing')
  assert.equal(result.skipped, 'missing')
})

test('recovers originCwd from an existing snapshot when the index is missing', async () => {
  const setup = await makeSetup()
  setup.persistence.seed(headerFor('session-origin2', setup.workspacePath), [event(0)])
  await setup.exporter.exportSession(setup.workspace, 'session-origin2', { force: true })

  const target = snapshotPath(setup.workspacePath, 'session-origin2')
  const lines = (await readFile(target, 'utf8')).split('\n')
  const header = JSON.parse(lines[0])
  header.cwd = '/original/machine/proj'
  lines[0] = JSON.stringify(header)
  await writeFile(target, lines.join('\n'), 'utf8')
  await rm(join(setup.workspacePath, '.dsh', 'workspace-session.json'))

  setup.persistence.sessions.get('session-origin2').events.push(event(1))
  await setup.exporter.exportSession(setup.workspace, 'session-origin2', { force: true })
  const parsed = parseSnapshot(await readFile(target, 'utf8'))
  assert.equal(parsed.header.cwd, '/original/machine/proj')
})

test('drops a trailing plain resume marker from the exported snapshot', async () => {
  const setup = await makeSetup()
  setup.persistence.seed(headerFor('session-resume', setup.workspacePath), [
    event(0),
    { type: 'session/end-seed', seq: 1, time: 2, data: {} },
  ])
  await setup.exporter.exportSession(setup.workspace, 'session-resume')
  const parsed = parseSnapshot(await readFile(snapshotPath(setup.workspacePath, 'session-resume'), 'utf8'))
  assert.equal(parsed.events.length, 1)
  assert.equal(parsed.events[0].type, 'turn/start')
  const second = await setup.exporter.exportSession(setup.workspace, 'session-resume')
  assert.equal(second.skipped, 'unchanged')
})

test('keeps an inherited seed marker in the exported snapshot', async () => {
  const setup = await makeSetup()
  setup.persistence.seed(headerFor('session-fork', setup.workspacePath), [
    event(0),
    { type: 'session/end-seed', seq: 1, time: 2, data: { inherited: true } },
    event(2),
  ])
  await setup.exporter.exportSession(setup.workspace, 'session-fork')
  const parsed = parseSnapshot(await readFile(snapshotPath(setup.workspacePath, 'session-fork'), 'utf8'))
  assert.equal(parsed.events.length, 3)
})
