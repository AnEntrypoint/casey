import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { countProjectTerms } from './lib/project-terms.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const baseline = JSON.parse(readFileSync(path.join(here, 'project-terms.baseline.json'), 'utf8'))

test('project-term hits in casey do not rise above the recorded baseline (the ratchet only goes down)', () => {
  const { total } = countProjectTerms(root)
  assert.ok(total <= baseline.total, `project-term hits ${total} exceed the baseline ${baseline.total}`)
})

test('casey test fixtures carry no project content: the generic config casey runs with has no uhh terms', () => {
  const { total } = countProjectTerms(path.join(here, 'fixtures'))
  assert.equal(total, 0)
})
