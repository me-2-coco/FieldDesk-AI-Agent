const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AccountStore } = require('../database/account-store');
const owner = { userId: 'FieldDesk0001', role: 'ADMIN', accountAuthority: 'OWNER' };
test('owner can specify unused low account numbers without relaxing admin or duplicate guards', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fd-owner-number-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new AccountStore({ driver: 'json', filePath: path.join(dir, 'accounts.json') });
  const input = { userId: 'FieldDesk0003', displayName: 'Test', phone: '13800000003', role: 'ADMIN' };
  const user = await store.createManagedAccount(input, owner);
  assert.equal(user.userId, 'FieldDesk0003');
  assert.equal(user.accountAuthority, undefined);
  await assert.rejects(async () => store.createManagedAccount(input, owner), { code: 'ACCOUNT_USER_ID_EXISTS' });
  const ordinary = { userId: 'FieldDesk0010', role: 'ADMIN' };
  await assert.rejects(async () => store.createManagedAccount({ ...input, userId: 'FieldDesk0002', role: 'INFORMATION_CLERK' }, ordinary), { code: 'ACCOUNT_USER_ID_BELOW_MINIMUM' });
});
test('new accounts require name and phone on both creation paths', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fd-required-profile-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new AccountStore({ driver: 'json', filePath: path.join(dir, 'accounts.json') });
  for (const method of ['createManagedAccount', 'upsert']) {
    const base = { userId: 'FieldDesk0005', role: 'INFORMATION_CLERK', password: 'synthetic-test-password' };
    await assert.rejects(async () => store[method](base, owner), { code: 'ACCOUNT_NAME_REQUIRED' });
    await assert.rejects(async () => store[method]({ ...base, displayName: 'Test' }, owner), { code: 'ACCOUNT_PHONE_REQUIRED' });
    await assert.rejects(async () => store[method]({ ...base, displayName: 'Test', phone: 'bad' }, owner), { code: 'ACCOUNT_PHONE_INVALID' });
  }
  assert.equal(await store.getNextManagedUserId(), 'FieldDesk0005');
  for (let i = 5; i <= 7; i++) {
    const user = await store.createManagedAccount({ displayName: `Test ${i}`, phone: `1380000000${i}`, role: 'INFORMATION_CLERK' }, owner);
    assert.equal(user.userId, `FieldDesk000${i}`);
  }
  assert.equal(await store.getNextManagedUserId(), 'FieldDesk0008');
});
