const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function createRateLimiter({ windowMs = 60_000, limit = 120, code = "RATE_LIMITED" } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) buckets.set(key, { count: 1, resetAt: now + windowMs });
    else if (++bucket.count > limit) return res.status(429).json({ success: false, code, message: "请求过于频繁，请稍后重试" });
    next();
  };
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

module.exports = { createRateLimiter, securityHeaders, RotatingJsonLogger, requestLogger };
