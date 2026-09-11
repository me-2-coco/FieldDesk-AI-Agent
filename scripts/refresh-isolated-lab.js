const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { allowedFile } = require('./start-isolated-lab');
(async () => {
  const source = path.resolve(__dirname, '..');
  const root = await fs.realpath(process.argv[2]);
  const temp = await fs.realpath(os.tmpdir());
  if (path.dirname(root) !== temp || !path.basename(root).startsWith('fielddesk-isolated-lab-')) throw new Error('Not a lab temp directory');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'lab-manifest.json'), 'utf8'));
  if (manifest.kind !== 'fielddesk-isolated-lab' || manifest.customerDataCopied !== false) throw new Error('Invalid lab manifest');
  // Stop only the verified lab listener before running this refresh script.
  for (const file of [...execFileSync('git', ['ls-files', '-z'], { cwd: source, encoding: 'utf8' }).split('\0').filter(allowedFile), 'scripts/isolated-lab-server.js']) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.copyFile(path.join(source, file), path.join(root, file));
  }
  await fs.cp(path.join(source, 'frontend/dist'), path.join(root, 'frontend/dist'), { recursive: true });
  const child = spawn(process.execPath, [path.join(root, 'scripts/isolated-lab-server.js')], {
    cwd: root, stdio: 'inherit', env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), NODE_ENV: 'development' },
  });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code || 0; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
})().catch(error => { console.error(error); process.exitCode = 1; });
