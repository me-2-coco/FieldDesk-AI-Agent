export const MAX_VIDEO_UPLOAD_BYTES = 100_000_000
export const TARGET_VIDEO_BYTES = 88_000_000

export function needsVideoCompression(file) {
  return String(file?.type || "").startsWith("video/")
    && Number(file?.size || 0) > MAX_VIDEO_UPLOAD_BYTES
}

export function targetVideoBitrate(durationSeconds, targetBytes = TARGET_VIDEO_BYTES) {
  const duration = Math.max(1, Number(durationSeconds || 0))
  return Math.max(250_000, Math.floor((targetBytes * 8) / duration - 96_000))
}

function recorderMimeType() {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ]
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || ""
}

function waitForVideoMetadata(video) {
  return new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve
    video.onerror = () => reject(new Error("无法读取视频，请重新选择原视频"))
  })
}

export async function compressVideoFile(file, { onProgress = () => {} } = {}) {
  if (!needsVideoCompression(file)) return file
  if (typeof MediaRecorder === "undefined" || typeof document === "undefined") {
    throw new Error("当前浏览器不支持自动压缩视频，请使用最新版 Chrome")
  }
  const canvas = document.createElement("canvas")
  if (typeof canvas.captureStream !== "function") {
    throw new Error("当前浏览器不支持自动压缩视频，请使用最新版 Chrome")
  }
  const mimeType = recorderMimeType()
  if (!mimeType) throw new Error("当前浏览器没有可用的视频压缩格式，请使用最新版 Chrome")

  const video = document.createElement("video")
  const sourceUrl = URL.createObjectURL(file)
  let animationFrame = 0
  let stream = null
  video.src = sourceUrl
  video.preload = "auto"
  video.playsInline = true
  video.muted = true
  try {
    await waitForVideoMetadata(video)
    const duration = Number(video.duration || 0)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取视频时长，请重新选择原视频")
    const scale = Math.min(1, 1280 / Math.max(1, video.videoWidth), 720 / Math.max(1, video.videoHeight))
    canvas.width = Math.max(2, Math.round(video.videoWidth * scale / 2) * 2)
    canvas.height = Math.max(2, Math.round(video.videoHeight * scale / 2) * 2)
    const context = canvas.getContext("2d", { alpha: false })
    if (!context) throw new Error("视频压缩组件初始化失败")

    stream = canvas.captureStream(24)
    const sourceStream = typeof video.captureStream === "function" ? video.captureStream() : null
    for (const track of sourceStream?.getAudioTracks?.() || []) stream.addTrack(track)
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: targetVideoBitrate(duration),
      audioBitsPerSecond: 96_000,
    })
    const chunks = []
    const finished = new Promise((resolve, reject) => {
      recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data) }
      recorder.onerror = () => reject(new Error("视频压缩失败，请重新选择视频"))
      recorder.onstop = resolve
    })
    const draw = () => {
      if (video.ended || video.paused) return
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      onProgress(Math.min(99, Math.round((video.currentTime / duration) * 100)))
      animationFrame = requestAnimationFrame(draw)
    }
    recorder.start(1000)
    const playbackFinished = new Promise((resolve, reject) => {
      video.onended = resolve
      video.onerror = () => reject(new Error("视频压缩过程中读取失败"))
    })
    await video.play()
    draw()
    await playbackFinished
    if (recorder.state !== "inactive") recorder.stop()
    await finished
    cancelAnimationFrame(animationFrame)
    const outputType = mimeType.split(";")[0]
    const extension = outputType === "video/mp4" ? ".mp4" : ".webm"
    const baseName = String(file.name || "维修视频").replace(/\.[^.]+$/, "")
    const compressed = new File(chunks, `${baseName}-已压缩${extension}`, {
      type: outputType,
      lastModified: Date.now(),
    })
    if (!compressed.size || compressed.size > MAX_VIDEO_UPLOAD_BYTES) {
      throw new Error("视频自动压缩后仍超过100MB，请缩短拍摄时长后重试")
    }
    onProgress(100)
    return compressed
  } finally {
    cancelAnimationFrame(animationFrame)
    for (const track of stream?.getTracks?.() || []) track.stop()
    video.pause()
    video.removeAttribute("src")
    URL.revokeObjectURL(sourceUrl)
  }
}
