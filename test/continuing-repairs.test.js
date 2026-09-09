const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const load = () => import(pathToFileURL(path.join(__dirname, '../frontend/src/shared/continuingRepairs.js')))
const base = { receiptCompletedAt: '2026-09-09', technicianId: 'T1', status: 'INSPECTION_IN_PROGRESS' }
const rows = [
  { ...base, rmaNo: 'A', sn: 'SN-ONE', updatedAt: '2026-09-09T01:00:00Z' },
  { ...base, rmaNo: 'B', technicianId: 'T2', updatedAt: '2026-09-09T03:00:00Z' },
  { ...base, rmaNo: 'C', status: 'ON_HOLD', hold: { reason: '网点缺件' } },
  { ...base, rmaNo: 'D', status: 'ON_HOLD', hold: { reason: '用户要求暂放' } },
  { ...base, rmaNo: 'DONE', repairCompletion: { submittedAt: '2026-09-09' } },
  { ...base, rmaNo: 'CANCELLED', status: 'CANCELLED' },
  { ...base, rmaNo: 'TRANSFERRED', status: 'TRANSFERRED_TO_HEADQUARTERS' },
]
test('technicians only see own active orders, never completed or released orders', async () => {
  const { continuingRepairs } = await load()
  const result = continuingRepairs(rows, { role: 'technician', userId: 'T1' })
  assert.deepEqual(result.rows.map(o => o.rmaNo), ['A', 'C', 'D'])
  assert.deepEqual(result.counts, { all: 3, repairing: 1, waiting: 1, held: 1 })
  assert.equal(continuingRepairs(rows, { role: 'technician' }).rows.length, 0)
  assert.equal(continuingRepairs(rows, { role: 'information_clerk' }).rows.length, 0)
})
test('manager filters by technician, status or case-insensitive SN with newest first', async () => {
  const { continuingRepairs } = await load()
  assert.deepEqual(continuingRepairs(rows, { role: 'admin' }).rows.map(o => o.rmaNo), ['B', 'A', 'C', 'D'])
  assert.deepEqual(continuingRepairs(rows, { accountAuthority: 'OWNER' }, { technicianId: 'T2' }).rows.map(o => o.rmaNo), ['B'])
  assert.deepEqual(continuingRepairs(rows, { role: 'admin' }, { keyword: ' sn-one ' }).rows.map(o => o.rmaNo), ['A'])
  assert.deepEqual(continuingRepairs(rows, { role: 'admin' }, { status: 'waiting' }).rows.map(o => o.rmaNo), ['C'])
})
