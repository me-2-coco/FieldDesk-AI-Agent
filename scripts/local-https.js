// Local Wi-Fi testing only. Keep private keys outside the public web root.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const net = require('node:net');
const { createLocalProxy } = require('./local-https-proxy');
const address = process.env.LOCAL_HTTPS_IP;
if (net.isIP(address) !== 4) throw new Error('Set LOCAL_HTTPS_IP to the computer LAN IPv4 address');
const dir = path.resolve(__dirname, '../runtime/local-https', address);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.umask(0o077);
const file = name => path.join(dir, name);
const openssl = args => execFileSync('openssl', args, { stdio: 'pipe' });
if (!fs.existsSync(file('ca.pem'))) {
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '365', '-subj', '/CN=FieldDesk Local Test CA', '-keyout', file('ca.key'), '-out', file('ca.pem'), '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
}
if (!fs.existsSync(file('server.pem'))) {
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', `/CN=${address}`, '-keyout', file('server.key'), '-out', file('server.csr')]);
  fs.writeFileSync(file('server.ext'), `subjectAltName=IP:${address},IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
  openssl(['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca.key'), '-CAcreateserial', '-out', file('server.pem'), '-days', '180', '-sha256', '-extfile', file('server.ext')]);
}
openssl(['x509', '-in', file('ca.pem'), '-outform', 'DER', '-out', file('fielddesk-local-ca.cer')]);
const proxy = https.createServer({ key: fs.readFileSync(file('server.key')), cert: fs.readFileSync(file('server.pem')) }, createLocalProxy());
// Explicitly reject unsupported HMR upgrades instead of leaving sockets pending.
proxy.on('upgrade', (req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n'));
// This port exposes only the PUBLIC CA certificate, never keys or project files.
const download = http.createServer((req, res) => {
  if (req.url !== '/fielddesk-local-ca.cer' || req.method !== 'GET') { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="fielddesk-local-ca.cer"', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file('fielddesk-local-ca.cer')));
});
proxy.listen(5443, address, () => console.log(`HTTPS: https://${address}:5443`));
download.listen(5444, address, () => console.log(`Public certificate: http://${address}:5444/fielddesk-local-ca.cer`));
for (const server of [proxy, download]) server.on('error', error => { console.error(error.message); process.exit(1); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { proxy.close(); download.close(); });
