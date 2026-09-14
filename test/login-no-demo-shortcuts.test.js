const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('login exposes no demo account shortcuts and retains authenticated login', () => {
  const source = fs.readFileSync(path.join(__dirname,'../frontend/src/pages/Login.jsx'),'utf8');
  assert.doesNotMatch(source,/login-demo-accounts|账号快捷填写|setAccount\("(?:zhang|wang|admin|li|zhao)"\)/);
  assert.match(source,/loginFieldDeskAccount\(account, password\)/);
  assert.match(source,/autoComplete="current-password"/);
  assert.match(source,/changeFieldDeskPassword/);
});
