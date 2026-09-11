const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawn } = require("node:child_process");

function allowedFile(file) {
  if (file === "server.js" || file === "package.json") return true;
  if (!/^(config|connectors|database|services|shared|knowledge)\//.test(file)) return false;
  if (file.split("/").some(part => part.startsWith(".") || ["data", "uploads", "runtime", "logs"].includes(part))) return false;
  if (/cookie|token|storage|state|screenshot|download/i.test(path.basename(file)) && !file.endsWith(".js")) return false;
  return /\.(js|json)$/.test(file);
}

async function provision(source) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-isolated-lab-"));
  await fs.chmod(root, 0o700);
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: source, encoding: "utf8" }).split("\0").filter(allowedFile);
  for (const file of [...tracked, "scripts/isolated-lab-server.js"]) {
    const input = path.join(source, file);
    if (!(await fs.lstat(input)).isFile()) throw new Error("Lab snapshot refuses symbolic source files");
    const output = path.join(root, file);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.copyFile(input, output);
  }
  await fs.cp(path.join(source, "frontend/dist"), path.join(root, "frontend/dist"), { recursive: true });
  // Share installed libraries only; code, accounts and runtime state are copies.
  await fs.symlink(path.join(source, "node_modules"), path.join(root, "node_modules"), "dir");
  await fs.writeFile(path.join(root, "lab-manifest.json"), JSON.stringify({
    kind: "fielddesk-isolated-lab", version: 1, createdAt: new Date().toISOString(),
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(),
    networkConnectors: "disabled", customerDataCopied: false,
  }, null, 2), { mode: 0o600 });
  return root;
}

async function main() {
  const source = path.resolve(__dirname, "..");
  const root = await provision(source);
  console.log(`ISOLATED_LAB_ROOT=${root}`);
  const child = spawn(process.execPath, [path.join(root, "scripts/isolated-lab-server.js")], {
    cwd: root, stdio: "inherit",
    env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), NODE_ENV: "development" },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", error => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code || 0; });
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { allowedFile, provision };
