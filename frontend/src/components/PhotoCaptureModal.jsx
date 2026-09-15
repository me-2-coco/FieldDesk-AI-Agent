import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { CameraIcon } from "./AppIcons.jsx"
import CameraTorchButton from "./CameraTorchButton.jsx"
import { stampPhoto } from "../shared/photoWatermark.js"
import "./photo-capture-modal.css"

function PhotoCaptureModal({ open, onCapture, onClose, title = "拍摄签收照片", filePrefix = "签收照片" }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const generationRef = useRef(0)
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [cameraTrack, setCameraTrack] = useState(null)

  useEffect(() => {
    if (!open) return undefined
    let active = true
    const timer = setTimeout(() => {
    busyRef.current = false
    setBusy(false)
    setError("")
    setCameraTrack(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("当前浏览器无法调用相机，请使用 HTTPS 地址")
      return
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then((stream) => {
        if (!active) return stream.getTracks().forEach((track) => track.stop())
        streamRef.current = stream
        setCameraTrack(stream.getVideoTracks()[0])
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.play().catch(() => { if (active) setError("相机画面启动失败，请关闭后重试") })
        }
      })
      .catch(() => { if (active) setError("无法打开摄像头，请允许相机权限后重试") })
    }, 0)
    return () => {
      generationRef.current += 1
      active = false
      clearTimeout(timer)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [open])

  async function takePhoto() {
    if (busyRef.current) return
    const video = videoRef.current
    if (!video?.videoWidth) return setError("相机尚未准备好")
    busyRef.current = true
    setBusy(true)
    setError("")
    const generation = generationRef.current
    const capturedAt = new Date()
    try {
      const canvas = document.createElement("canvas")
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.getContext("2d").drawImage(video, 0, 0)
      const stamped = stampPhoto(canvas, capturedAt)
      const blob = await new Promise((resolve) => stamped.toBlob(resolve, "image/jpeg", 0.92))
      if (generation !== generationRef.current) return
      if (!blob) throw new Error("照片生成失败，请重试")
      onCapture(new File([blob], `${filePrefix}-${capturedAt.getTime()}.jpg`, { type: "image/jpeg" }))
      onClose()
    } catch (err) {
      if (generation === generationRef.current) setError(err.message || "拍照失败，请重试")
    } finally {
      if (generation === generationRef.current) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  if (!open) return null
  return createPortal(<div className="fd-photo-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <video ref={videoRef} className="fd-photo-video" playsInline muted autoPlay />
      <header className="fd-photo-header">
        <button className="fd-camera-close" type="button" aria-label="关闭相机" onClick={onClose}><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
        <span>{title}</span>
        {cameraTrack ? <CameraTorchButton key={cameraTrack.id} track={cameraTrack} /> : <span />}
      </header>
      <footer className="fd-photo-controls">
        {error && <p role="alert">{error}</p>}
        {busy && <span role="status">正在生成水印，请稍候…</span>}
        <button type="button" className="fd-photo-shutter" aria-label="拍照" onClick={takePhoto} disabled={busy || !cameraTrack}><CameraIcon size={28} /></button>
      </footer>
  </div>, document.body)
}

export default PhotoCaptureModal
