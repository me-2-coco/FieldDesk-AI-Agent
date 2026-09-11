const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");
const { resolveUploadDirectory, resolveBackupUploadDirectory } = require("../config/upload-paths");
const root = path.join(__dirname, "..");

test("production attachments and backup share a writable sibling of data", () => {
  const env = parseEnv(fs.readFileSync(path.join(root, "deploy/env/production.env.template"), "utf8"));
  assert.equal(resolveUploadDirectory(env), "/var/lib/fielddesk/uploads");
  assert.equal(resolveBackupUploadDirectory(env), resolveUploadDirectory(env));
  assert.equal(path.dirname(env.FIELDDESK_SQLITE_FILE), env.FIELDDESK_DATA_DIRECTORY);
  assert.equal(path.dirname(resolveUploadDirectory(env)), path.dirname(env.FIELDDESK_DATA_DIRECTORY));
  const service = fs.readFileSync(path.join(root, "deploy/systemd/fielddesk.service"), "utf8");
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /ReadWritePaths=\/var\/lib\/fielddesk /);
});

test("legacy paths stay compatible and contradictory backup overrides fail closed", () => {
  assert.equal(resolveUploadDirectory({}), path.join(root, "database/uploads"));
  assert.equal(resolveBackupUploadDirectory({}), resolveUploadDirectory({}));
  assert.equal(resolveBackupUploadDirectory({ FIELDDESK_DATA_DIRECTORY: "/tmp/lab/data" }), "/tmp/lab/uploads");
  assert.throws(() => resolveBackupUploadDirectory({ FIELDDESK_UPLOAD_DIRECTORY: "/tmp/a", FIELDDESK_BACKUP_UPLOAD_DIRECTORY: "/tmp/b" }), /不一致/);
});

test("proxy accepts API body budget without a shared NAT business bucket", () => {
  const nginx = fs.readFileSync(path.join(root, "deploy/nginx/fielddesk.conf"), "utf8");
  assert.match(nginx, /client_max_body_size 140m;/);
  assert.doesNotMatch(nginx, /^\s*limit_req(?:_zone)?\s/m);
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  for (const category of ["repairs", "receipts", "shipments"]) {
    assert.ok(server.includes(`path.join(uploadDirectory, "${category}")`));
  }
  assert.match(server, /app.use\(createBusinessRateLimiter/);
});
