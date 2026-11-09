import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureGitignore, GITIGNORE_PATTERNS } from '../lib/gitignore.js'
import { tempDir } from './helpers.js'

test('creates a .gitignore with every managed rule', async () => {
  const dir = tempDir('ws-')
  const result = await ensureGitignore(dir)
  assert.equal(result.changed, true)
  assert.deepEqual([...result.missing].sort(), [...GITIGNORE_PATTERNS].sort())
  const text = await readFile(join(dir, '.gitignore'), 'utf8')
  for (const pattern of GITIGNORE_PATTERNS) assert.ok(text.includes(pattern))
})

test('preserves existing rules and appends only missing ones', async () => {
  const dir = tempDir('ws-')
  const path = join(dir, '.gitignore')
  await writeFile(path, 'node_modules\n.dsh/workspace-session.json\n', 'utf8')
  const result = await ensureGitignore(dir)
  assert.equal(result.changed, true)
  const text = await readFile(path, 'utf8')
  assert.ok(text.startsWith('node_modules\n.dsh/workspace-session.json\n'))
  assert.equal(text.match(/\.dsh\/workspace-session\.json/g).length, 1)
  assert.ok(text.includes('.dsh/sessions/**/session.lock'))
})

test('is idempotent', async () => {
  const dir = tempDir('ws-')
  await ensureGitignore(dir)
  const second = await ensureGitignore(dir)
  assert.equal(second.changed, false)
  assert.equal(second.missing.length, 0)
})
