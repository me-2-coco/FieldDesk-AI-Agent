// Fixed business label, not a claim of GPS-verified location.
export function stampPhoto(source, capturedAt) {
  const pad = (n) => String(n).padStart(2, "0")
  const date = new Date(capturedAt.getTime() + 8 * 60 * 60 * 1000)
  const time = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  const lines = [
    `拍摄时间：${time}（北京时间）`,
    "成都追觅维修中心",
  ]
  const canvas = document.createElement("canvas")
  const fontSize = Math.max(12, Math.round(source.width / 42))
  const padding = Math.max(10, Math.round(source.width / 60))
  const lineHeight = Math.ceil(fontSize * 1.6)
  canvas.width = source.width
  canvas.height = source.height + padding * 2 + lineHeight * lines.length
  const ctx = canvas.getContext("2d")
  ctx.drawImage(source, 0, 0)
  ctx.fillStyle = "#111827"
  ctx.fillRect(0, source.height, canvas.width, canvas.height - source.height)
  ctx.fillStyle = "#ffffff"
  ctx.font = `${fontSize}px sans-serif`
  ctx.textBaseline = "top"
  lines.forEach((line, index) => ctx.fillText(line, padding, source.height + padding + index * lineHeight, canvas.width - padding * 2))
  return canvas
}
