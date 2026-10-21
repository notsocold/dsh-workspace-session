import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SESSION_FORMAT_VERSION,
  findInheritedEventCount,
  importHeader,
  normalizeEventForCompare,
  parseSnapshot,
  rewriteWorkingDirectory,
  serializeSnapshot,
  snapshotHeader,
} from '../lib/snapshot.js'
import { encodeSegment } from '../lib/util.js'

const header = {
  type: 'session',
  version: SESSION_FORMAT_VERSION,
  id: 'session-abc',
  createdAt: 1700000000000,
  cwd: '/home/alice/proj',
  isSeeded: false,
  delegationDepth: 0,
}

const events = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 2, data: { message: { role: 'user', content: 'hi' } } },
]

test('snapshot round-trip preserves header and events', () => {
  const text = serializeSnapshot({ header, events })
  const parsed = parseSnapshot(text)
  assert.equal(parsed.header.id, 'session-abc')
  assert.equal(parsed.header.cwd, '/home/alice/proj')
  assert.equal(parsed.events.length, 2)
  assert.deepEqual(parsed.events[1].data, events[1].data)
})

test('parseSnapshot rejects a gap in event seq', () => {
  const text = JSON.stringify(header) + '\n' + JSON.stringify({ type: 'a', seq: 1, time: 1, data: {} })
  assert.throws(() => parseSnapshot(text), /seq/)
})

test('snapshotHeader keeps the original cwd and drops unknown fields', () => {
  const value = snapshotHeader({ ...header, extra: 'ignored' }, '/original/proj')
  assert.equal(value.type, 'session')
  assert.equal(value.cwd, '/original/proj')
  assert.equal('extra' in value, false)
  assert.equal(value.delegationDepth, 0)
})

test('importHeader remaps cwd to this machine', () => {
  const value = importHeader(header, '/home/bob/proj')
  assert.equal(value.cwd, '/home/bob/proj')
  assert.equal('type' in value, false)
  assert.equal(value.id, 'session-abc')
})

test('findInheritedEventCount locates the inherited seed marker', () => {
  const seeded = [
    { type: 'turn/start', seq: 0, time: 1, data: {} },
    { type: 'user/message', seq: 1, time: 2, data: {} },
    { type: 'session/end-seed', seq: 2, time: 3, data: { inherited: true } },
  ]
  assert.equal(findInheritedEventCount(seeded), 2)
  assert.equal(findInheritedEventCount(events), 0)
})

test('rewriteWorkingDirectory remaps committed transitions only', () => {
  const input = [
    { type: 'working-directory/change', seq: 0, time: 1, data: { cwd: '/old' } },
    { type: 'turn/start', seq: 1, time: 2, data: {} },
  ]
  const output = rewriteWorkingDirectory(input, '/new')
  assert.equal(output[0].data.cwd, '/new')
  assert.equal(input[0].data.cwd, '/old')
})

test('normalizeEventForCompare ignores the machine path', () => {
  const a = normalizeEventForCompare({ type: 'working-directory/change', seq: 0, time: 1, data: { cwd: '/a' } })
  const b = normalizeEventForCompare({ type: 'working-directory/change', seq: 0, time: 1, data: { cwd: '/b' } })
  assert.deepEqual(a, b)
})

test('encodeSegment keeps readable ids and escapes separators', () => {
  assert.equal(encodeSegment('session-abc'), 'session-abc')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  assert.equal(encodeSegment('..'), '~002E~002E')
})
