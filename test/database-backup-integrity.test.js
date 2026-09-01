const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const script = path.join(__dirname, "../scripts/database-maintenance.js");

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

test("backup writes a checksum manifest and refuses corrupted restore data", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-backup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const backups = path.join(root, "backups");
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(data, "orders.json"), "[]\n");
  const env = { FIELDDESK_DATA_DIRECTORY: data, FIELDDESK_BACKUP_DIRECTORY: backups };

  const created = await run(["backup"], env);
  assert.equal(created.code, 0, created.stderr);
  const manifest = JSON.parse(await fs.readFile(path.join(created.stdout, "fielddesk-backup-manifest.json"), "utf8"));
  assert.equal(manifest.files[0].path, "orders.json");
  assert.match(manifest.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal((await run(["verify", created.stdout], env)).code, 0);

  await fs.writeFile(path.join(created.stdout, "orders.json"), "corrupted\n");
  const corrupted = await run(["verify", created.stdout], env);
  assert.notEqual(corrupted.code, 0);
  assert.match(corrupted.stderr, /备份完整性校验失败/);
});
