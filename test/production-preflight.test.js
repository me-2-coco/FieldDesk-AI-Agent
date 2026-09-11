const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");
const { spawnSync } = require("node:child_process");
const { checkConfig, checkHost } = require("../scripts/production-preflight");
const template = path.join(__dirname, "../deploy/env/production.env.template");
const env = () => ({ ...parseEnv(fs.readFileSync(template, "utf8")),
  FRONTEND_ORIGIN: "https://fielddesk.internal.test", FIELDDESK_BOOTSTRAP_ADMIN_TOKEN: "" });

test("template cannot accidentally pass as configured production", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "../scripts/production-preflight.js"), "--env-file", template, "--config-only"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /占位域名/);
  assert.doesNotMatch(result.stderr, /REPLACE_WITH_SECRET_MANAGER/);
});
test("configured profile passes; overlapping directories and missing paths fail", () => {
  assert.deepEqual(checkConfig(env()), []);
  assert.ok(checkConfig({ ...env(), FIELDDESK_UPLOAD_DIRECTORY: "/var/lib/fielddesk/data/uploads" }).some(x => x.includes("不得重叠")));
  assert.ok(checkConfig({ ...env(), FIELDDESK_UPLOAD_DIRECTORY: "" }).some(x => x.includes("绝对路径")));
});
test("mismatched backup and unsafe profile are refused without exposing secrets", () => {
  const failures = checkConfig({ ...env(), FIELDDESK_BACKUP_UPLOAD_DIRECTORY: "/tmp/wrong", RECLOUD_WRITE_ENABLED: "true", FIELDDESK_BOOTSTRAP_ADMIN_TOKEN: "private-short-value", REQUEST_BODY_LIMIT: "20mb" });
  assert.ok(failures.some(x => x.includes("不一致")));
  assert.ok(failures.some(x => x.includes("瑞云")));
  assert.ok(failures.some(x => x.includes("上传大小")));
  assert.ok(!failures.join().includes("private-short-value"));
});
test("host check does not create missing directories and rejects non-Linux", () => {
  let calls = 0;
  const failures = checkHost(env(), { platform: "darwin", fileSystem: { lstatSync() { calls++; throw new Error("synthetic missing"); } } });
  assert.equal(calls, 4);
  assert.ok(failures.some(x => x.includes("Linux")));
  assert.equal(failures.filter(x => x.includes("目录不存在")).length, 4);
});
