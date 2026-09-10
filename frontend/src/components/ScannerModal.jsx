import { useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Html5Qrcode } from "html5-qrcode"
import "./scanner-modal.css"

function ScannerModal({ open, mode = "logistics", title = "扫码", onScan, onClose }) {
  const areaId = `scanner-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const callbacks = useRef({ onScan, onClose })
  const [cameraError, setCameraError] = useState("")
  const [ready, setReady] = useState(false)
  useEffect(() => { callbacks.current = { onScan, onClose } }, [onScan, onClose])
  useEffect(() => {
    if (!open) return
    let active = true
    let scanner
    let starting
    let stopping
    let decoded = false
    const stop = () => stopping ||= (async () => {
      await starting?.catch(() => {})
      if (scanner?.isScanning) await scanner.stop().catch(() => {})
      try { scanner?.clear() } catch { /* View already removed. */ }
    })()
    // StrictMode discards its first effect before this acquisition can begin.
    const timer = setTimeout(() => {
      if (!active) return
      setCameraError("")
      setReady(false)
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError("当前浏览器无法调用相机，请使用已信任证书的 HTTPS 地址")
        return
      }
      scanner = new Html5Qrcode(areaId)
      starting = scanner.start({ facingMode: "environment" }, {
        fps: 10,
        qrbox: (width, height) => {
          const size = Math.max(1, Math.floor(Math.min(width, height, 360) * 0.8))
          return { width: size, height: size }
        },
      }, async text => {
        if (!active || decoded) return
        decoded = true
        await stop()
        if (active) {
          callbacks.current.onScan(text)
          callbacks.current.onClose()
        }
      }, () => {})
      starting.then(() => {
        if (active) setReady(true)
        else void stop()
      }).catch(error => {
        if (active) setCameraError(`相机启动失败：${error?.message || String(error)}。请关闭重试或手动输入。`)
      })
    }, 0)
    const escape = event => { if (event.key === "Escape") callbacks.current.onClose() }
    window.addEventListener("keydown", escape)
    return () => {
      active = false
      clearTimeout(timer)
      window.removeEventListener("keydown", escape)
      void stop()
    }
  }, [areaId, mode, open])
  if (!open) return null
  return createPortal(<div className="fd-scanner-overlay" role="dialog" aria-modal="true" aria-label={title}>
    <header className="fd-scanner-header"><strong>{title}</strong><button type="button" onClick={onClose}>关闭扫码</button></header>
    <div className="fd-scanner-view" id={areaId} />
    <footer className="fd-scanner-footer">
      <p role="status">{cameraError || (!ready ? "正在启动相机…" : mode === "sn" ? "请对准机器 SN 条码或二维码" : mode === "part" ? "请对准物料条码" : "请对准物流条码")}</p>
      <button type="button" onClick={onClose}>关闭并手动输入</button>
    </footer>
  </div>, document.body)
}
export default ScannerModal
