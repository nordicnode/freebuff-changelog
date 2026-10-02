import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SIZE_MAX_BYTES, SIZE_WARN_BYTES, findOverBudget, sizeText } from '../lib/sizebudget.mjs'

const MiB = 1048576

test('the budget leaves runway under GitHub\u2019s 100 MiB push block', () => {
  assert.ok(SIZE_WARN_BYTES > 0)
  assert.ok(SIZE_WARN_BYTES < SIZE_MAX_BYTES, 'warn before block')
  assert.ok(SIZE_MAX_BYTES < 100 * MiB, 'the relay must refuse before GitHub does')
  assert.ok(SIZE_WARN_BYTES < SIZE_MAX_BYTES - 10 * MiB, 'the warning band must leave room to react')
})

test('findOverBudget separates over and near, biggest first', () => {
  const { over, near } = findOverBudget([
    { path: 'data/small.json', bytes: 5 * MiB },
    { path: 'data/warn-big.json', bytes: SIZE_WARN_BYTES + MiB },
    { path: 'data/warn-small.json', bytes: SIZE_WARN_BYTES },
    { path: 'data/over-small.json', bytes: SIZE_MAX_BYTES },
    { path: 'data/over-big.json', bytes: SIZE_MAX_BYTES + 10 * MiB }
  ])
  assert.deepEqual(over.map(f => f.path), ['data/over-big.json', 'data/over-small.json'])
  assert.deepEqual(near.map(f => f.path), ['data/warn-big.json', 'data/warn-small.json'])
})

test('a file exactly at the budget is over, not near', () => {
  const { over, near } = findOverBudget([{ path: 'data/exact.json', bytes: SIZE_MAX_BYTES }])
  assert.equal(over.length, 1)
  assert.equal(near.length, 0)
})

test('malformed entries are ignored instead of crashing the gate', () => {
  const { over, near } = findOverBudget([null, undefined, {}, { path: 'x' }, { path: 'y', bytes: 'big' }, { path: 'data/z.json', bytes: SIZE_MAX_BYTES }])
  assert.equal(over.length, 1)
  assert.equal(over[0].path, 'data/z.json')
  assert.equal(near.length, 0)
})

test('sizeText reads in MiB', () => {
  assert.equal(sizeText(85 * MiB), '85.0 MiB')
  assert.equal(sizeText(1.5 * MiB), '1.5 MiB')
})
