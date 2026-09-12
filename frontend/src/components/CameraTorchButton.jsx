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
    if (pending.current || !supported) return
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
    <button type="button" aria-pressed={enabled} disabled={!supported || busy} onClick={toggle}>
      {busy ? "正在切换补光灯…" : enabled ? "关闭闪光灯（补光）" : "打开闪光灯（补光）"}
    </button>
    {(!supported || error) && <small role="status">{error || "当前设备或浏览器不支持补光灯，请使用外部照明"}</small>}
  </div>
}
