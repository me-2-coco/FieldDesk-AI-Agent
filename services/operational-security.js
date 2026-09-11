const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function createRateLimiter({ windowMs = 60_000, limit = 120, code = "RATE_LIMITED", keyGenerator, now = Date.now } = {}) {
  if (!Number.isFinite(limit) || limit < 1) limit = 120;
  const buckets = new Map();
  let nextCleanup = 0;
  return (req, res, next) => {
    const key = keyGenerator ? keyGenerator(req) : req.ip || req.socket?.remoteAddress || "unknown";
    const timestamp = now();
    if (timestamp >= nextCleanup) {
      for (const [id, bucket] of buckets) if (bucket.resetAt <= timestamp) buckets.delete(id);
      nextCleanup = timestamp + windowMs;
    }
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= timestamp) buckets.set(key, { count: 1, resetAt: timestamp + windowMs });
    else if (++bucket.count > limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - timestamp) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ success: false, code, retryAfterSeconds, message: `请求过于频繁，请${retryAfterSeconds}秒后重试` });
    }
    next();
  };
}

function businessRateScope(req) {
  const path = req.path || "";
  if (["GET", "HEAD"].includes(req.method)) {
    return /\/(sync-status|local-state|my-sync-alerts|order-status|inbox|supervision|local-orders|todos)$/.test(path) || path === "/api/supervision/monitor/status"
      ? "poll" : "read";
  }
  return /\/attachments(?:\/|$)/.test(path) ? "upload" : "write";
}

function createBusinessRateLimiter({ getUser, readLimit = 600, writeLimit = 180, pollLimit = 300, uploadLimit = 120, ...options } = {}) {
  const keyGenerator = req => {
    const user = getUser(req);
    return user?.userId ? `user:${user.userId}` : `ip:${req.ip || req.socket?.remoteAddress || "unknown"}`;
  };
  const limits = { read: readLimit, write: writeLimit, poll: pollLimit, upload: uploadLimit };
  const limiters = Object.fromEntries(Object.entries(limits).map(([scope, limit]) =>
    [scope, createRateLimiter({ ...options, limit, keyGenerator })]));
  return (req, res, next) => limiters[businessRateScope(req)](req, res, next);
}

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}

class RotatingJsonLogger {
  constructor(options = {}) {
    this.directory = options.directory || path.join(process.cwd(), "logs");
    this.maxBytes = Number(options.maxBytes || 10 * 1024 * 1024);
    this.retention = Number(options.retention || 14);
  }
  write(stream, event) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, `${stream}.log`);
    try {
      if (fs.statSync(file).size >= this.maxBytes) fs.renameSync(file, `${file}.${Date.now()}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    fs.appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
    const rotated = fs.readdirSync(this.directory).filter((name) => name.startsWith(`${stream}.log.`)).sort().reverse();
    rotated.slice(this.retention).forEach((name) => fs.unlinkSync(path.join(this.directory, name)));
  }
}

function requestLogger(logger) {
  return (req, res, next) => {
    const startedAt = Date.now();
    const requestId = String(req.headers["x-request-id"] || crypto.randomUUID());
    res.setHeader("X-Request-Id", requestId);
    res.on("finish", () => logger.write(res.statusCode >= 500 ? "error" : "application", {
      requestId, method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - startedAt,
    }));
    next();
  };
}

module.exports = { createRateLimiter, createBusinessRateLimiter, businessRateScope, securityHeaders, RotatingJsonLogger, requestLogger };
