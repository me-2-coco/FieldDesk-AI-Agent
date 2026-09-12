import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { CameraIcon } from "./AppIcons.jsx"
import CameraTorchButton from "./CameraTorchButton.jsx"
import "./photo-capture-modal.css"

function PhotoCaptureModal({ open, onCapture, onClose, title = "拍摄签收照片", filePrefix = "签收照片" }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [error, setError] = useState("")
  const [cameraTrack, setCameraTrack] = useState(null)

  useEffect(() => {
    if (!open) return undefined
    let active = true
    const timer = setTimeout(() => {
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
      active = false
      clearTimeout(timer)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [open])

  function takePhoto() {
    const video = videoRef.current
    if (!video?.videoWidth) return setError("相机尚未准备好")
    const canvas = document.createElement("canvas")
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext("2d").drawImage(video, 0, 0)
    canvas.toBlob((blob) => {
      if (!blob) return setError("照片生成失败，请重试")
      onCapture(new File([blob], `${filePrefix}-${Date.now()}.jpg`, { type: "image/jpeg" }))
      onClose()
    }, "image/jpeg", 0.9)
  }

  if (!open) return null
  return createPortal(<div className="fd-photo-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <video ref={videoRef} className="fd-photo-video" playsInline muted autoPlay />
      <header className="fd-photo-header"><span>{title}</span><button type="button" aria-label="关闭相机" onClick={onClose}>✕ 关闭</button></header>
      <footer className="fd-photo-controls">
        {cameraTrack && <CameraTorchButton key={cameraTrack.id} track={cameraTrack} />}
        {error && <p role="alert">{error}</p>}
        <button type="button" className="fd-photo-shutter" aria-label="拍照" onClick={takePhoto} disabled={Boolean(error)}><CameraIcon size={28} /></button>
        <span>拍照</span>
      </footer>
  </div>, document.body)
}

export default PhotoCaptureModal
