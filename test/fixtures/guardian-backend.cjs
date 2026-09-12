const server = require('node:http').createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ success: true, service: 'fielddesk-api', pid: process.pid }));
});
server.listen(Number(process.env.PORT));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop); process.on('disconnect', stop);
