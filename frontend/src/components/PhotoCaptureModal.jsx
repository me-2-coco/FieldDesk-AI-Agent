import { useEffect, useRef, useState } from "react"
import { CameraIcon } from "./AppIcons.jsx"

function PhotoCaptureModal({ open, onCapture, onClose, title = "拍摄签收照片", filePrefix = "签收照片" }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open) return undefined
    let active = true
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then((stream) => {
        if (!active) return stream.getTracks().forEach((track) => track.stop())
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.play().catch(() => {})
        }
      })
      .catch(() => setError("无法打开摄像头，请允许相机权限后重试"))
    return () => {
      active = false
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
  return <div className="scanner-mask photo-capture-mask">
    <div className="scanner-box photo-capture-box">
      <div className="scanner-header"><span>{title}</span><button className="scanner-close" onClick={onClose}>✕</button></div>
      <video ref={videoRef} className="photo-capture-video" playsInline muted />
      {error && <p className="camera-error-text">{error}</p>}
      <button type="button" className="camera-shutter" onClick={takePhoto} disabled={Boolean(error)}><CameraIcon size={22} />拍照</button>
    </div>
  </div>
}

export default PhotoCaptureModal
