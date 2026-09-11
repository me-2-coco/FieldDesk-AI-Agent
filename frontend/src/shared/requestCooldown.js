export function requestScope(method, path) {
  path = path.split("?")[0]
  if (["GET", "HEAD"].includes(method)) {
    return /\/(sync-status|local-state|my-sync-alerts|order-status|inbox|supervision|local-orders|todos)$/.test(path)
      || path === "/api/supervision/monitor/status" ? "poll" : "read"
  }
  return /\/attachments(?:\/|$)/.test(path) ? "upload" : "write"
}

export function createRequestCooldown(now = Date.now) {
  const deadlines = new Map()
  return {
    reset() { deadlines.clear() },
    record(scope, seconds) {
      const delay = Number(seconds)
      deadlines.set(scope, now() + (Number.isFinite(delay) && delay > 0 ? delay : 60) * 1000)
    },
    check(scope) {
      const seconds = Math.ceil(((deadlines.get(scope) || 0) - now()) / 1000)
      if (seconds <= 0) return
      const error = new Error(`请求过于频繁，请${seconds}秒后重试`)
      error.code = "RATE_LIMITED"
      error.status = 429
      error.retryAfterSeconds = seconds
      throw error
    },
  }
}
