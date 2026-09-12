import { useEffect, useRef, useState } from "react"
import { setCameraTorch, supportsTorch } from "../shared/cameraTorch.js"
import "./camera-torch.css"

export default function CameraTorchButton({ track }) {
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const pending = useRef(null)
  const active = useRef(true)
  const supported = supportsTorch(track)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      // Camera owners also stop the track; release any in-flight light request.
      Promise.resolve(pending.current).catch(() => {}).then(() => {
        if (track?.readyState === "live" && supportsTorch(track)) return setCameraTorch(track, false)
      }).catch(() => {})
    }
  }, [track])
  async function toggle() {
    if (pending.current) return
    if (!supported) {
      setError("当前设备或浏览器不支持补光灯，请使用外部照明")
      return
    }
    setBusy(true)
    setError("")
    pending.current = setCameraTorch(track, !enabled)
    try {
      const actual = await pending.current
      if (active.current) setEnabled(actual)
    } catch (failure) {
      if (active.current) {
        setEnabled(track.getSettings?.().torch === true)
        setError(failure.message || "补光灯切换失败，可重试，不影响扫码和拍照")
      }
    } finally {
      pending.current = null
      if (active.current) setBusy(false)
    }
  }
  return <div className="fd-camera-torch">
    <button type="button" aria-label={busy ? "正在切换闪光灯" : enabled ? "关闭闪光灯" : "打开闪光灯"} title={enabled ? "关闭闪光灯" : "打开闪光灯"} aria-pressed={enabled} disabled={busy} onClick={toggle}>
      <svg viewBox="0 0 24 24" width="23" height="23" fill={enabled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><path d="m13.5 2-9 12h6l-1 8 10-13h-6z" />{!enabled && <path d="m3 3 18 18" />}</svg>
    </button>
    {error && <small role="status">{error}</small>}
  </div>
}
