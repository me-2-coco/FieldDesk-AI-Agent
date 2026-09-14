const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('cloud browser profile and lock live outside the versioned release', () => {
  const profile = '/var/lib/fielddesk/recloud-profile';
  const output = execFileSync(process.execPath, ['-e',
    'const s=require("./connectors/recloud-session"); console.log(JSON.stringify([s.RECLOUD_PROFILE_DIRECTORY,s.RECLOUD_PROFILE_LOCK]));'
  ], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, RECLOUD_PROFILE_DIRECTORY: profile }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), [profile, `${profile}.lock`]);
});
