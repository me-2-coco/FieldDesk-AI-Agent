// Coordinates stay in the attachment; no third-party geocoding service is used.
export function locatePhoto() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("当前浏览器不支持定位，请使用 HTTPS 并允许位置权限"))
    navigator.geolocation.getCurrentPosition(resolve, (error) => {
      reject(new Error(error.code === 1
        ? "请在浏览器设置中允许位置权限后重新拍照，照片必须带时间和位置水印"
        : "定位失败，请到信号较好的位置重新拍照"))
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 })
  })
}

export function stampPhoto(source, capturedAt, position) {
  const { latitude, longitude, accuracy } = position.coords
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new Error("定位数据无效，请重新拍照")
  }
  const pad = (n) => String(n).padStart(2, "0")
  const date = new Date(capturedAt.getTime() + 8 * 60 * 60 * 1000)
  const time = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  const lines = [
    `拍摄时间：${time}（北京时间）`,
    `位置：纬度 ${latitude.toFixed(6)}  经度 ${longitude.toFixed(6)}`,
    `手机定位（WGS84）${Number.isFinite(accuracy) ? ` · 精度约 ${Math.ceil(accuracy)} 米` : ""}`,
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
