const http = require('node:http');
const crypto = require('node:crypto');

// API traffic must not depend on the frontend development/HMR server.
function createLocalProxy({ apiPort = 3000, frontendPort = 5173, timeoutMs = 180000, log = console.log } = {}) {
  return (req, res) => {
    const api = req.url === '/api' || req.url.startsWith('/api/');
    const suppliedId = String(req.headers['x-request-id'] || '');
    const requestId = /^[a-zA-Z0-9-]{8,80}$/.test(suppliedId) ? suppliedId : crypto.randomUUID();
    const started = Date.now();
    const path = req.url.split('?')[0];
    const record = event => { if (api) log(JSON.stringify({ event, requestId, at: new Date().toISOString(), status: res.statusCode, method: req.method, path, durationMs: Date.now() - started })); };
    const headers = { ...req.headers, host: `127.0.0.1:${api ? apiPort : frontendPort}`, 'x-request-id': requestId };
    // This HTTP handler never upgrades connections. Do not forward hop-by-hop headers.
    for (const name of String(headers.connection || '').split(',')) delete headers[name.trim().toLowerCase()];
    delete headers.connection;
    delete headers.upgrade;
    const upstream = http.request({ hostname: '127.0.0.1', port: api ? apiPort : frontendPort, path: req.url, method: req.method, headers }, response => {
      res.writeHead(response.statusCode, { ...response.headers, 'x-request-id': requestId });
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    let deadline;
    const fail = (status, code, message) => {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      res.writeHead(status, { 'Content-Type': 'application/json', 'x-request-id': requestId });
      res.end(JSON.stringify({ success: false, code, message }));
    };
    upstream.on('error', () => fail(502, 'LOCAL_PROXY_UNAVAILABLE', '无法连接本机后台服务'));
    record('proxy_request_started');
    deadline = setTimeout(() => {
      record('proxy_request_timeout');
      fail(504, 'LOCAL_PROXY_TIMEOUT', '后台响应超时，请稍后重试');
      upstream.destroy();
    }, timeoutMs);
    res.on('finish', () => { clearTimeout(deadline); record('proxy_request_finished'); });
    res.on('close', () => {
      clearTimeout(deadline);
      if (!res.writableFinished) record('proxy_client_disconnected');
      upstream.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  };
}

module.exports = { createLocalProxy };
