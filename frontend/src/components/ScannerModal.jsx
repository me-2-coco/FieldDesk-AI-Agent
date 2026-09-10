import { useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Html5Qrcode, Html5QrcodeSupportedFormats as Formats } from "html5-qrcode"
import { fullFrameScanConfig, enableContinuousFocus } from "../shared/scannerConfig.js"
import { FullFrameBarcodeScanner } from "../shared/FullFrameBarcodeScanner.js"
import "./scanner-modal.css"

function ScannerModal({ open, mode = "logistics", title = "扫码", onScan, onClose }) {
  const areaId = `scanner-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const callbacks = useRef({ onScan, onClose })
  const shutdown = useRef(Promise.resolve())
  const [cameraError, setCameraError] = useState("")
  const [ready, setReady] = useState(false)
  const [scanType, setScanType] = useState("barcode")
  // Keep the previously working mobile path as default until the new engine
  // has passed physical-device verification. Users can explicitly try HD.
  const [compatibility, setCompatibility] = useState(true)
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
    const timer = setTimeout(async () => {
      await shutdown.current
      if (!active) return
      setCameraError("")
      setReady(false)
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError("当前浏览器无法调用相机，请使用已信任证书的 HTTPS 地址")
        return
      }
      scanner = scanType === "barcode" && !compatibility ? new FullFrameBarcodeScanner(areaId)
        : new Html5Qrcode(areaId, { formatsToSupport: scanType === "qr" ? [Formats.QR_CODE]
          : [Formats.CODE_128, Formats.CODE_39, Formats.CODE_93, Formats.ITF, Formats.CODABAR, Formats.EAN_13, Formats.EAN_8, Formats.UPC_A, Formats.UPC_E] })
      starting = scanner.start({ facingMode: "environment" }, fullFrameScanConfig, async text => {
        if (!active || decoded) return
        decoded = true
        await stop()
        if (active) {
          callbacks.current.onScan(text)
          callbacks.current.onClose()
        }
      }, error => { if (active && scanType === "barcode" && !compatibility) setCameraError(String(error)) })
      starting.then(() => {
        if (active) {
          setReady(true)
          void enableContinuousFocus(scanner)
        }
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
      shutdown.current = stop()
    }
  }, [areaId, mode, open, scanType, compatibility])
  if (!open) return null
  return createPortal(<div className="fd-scanner-overlay" role="dialog" aria-modal="true" aria-label={title}>
    <header className="fd-scanner-header"><strong>{title}</strong><button type="button" onClick={onClose}>关闭扫码</button></header>
    <div className="fd-scanner-view" id={areaId} />
    <footer className="fd-scanner-footer">
      {scanType === "barcode" && <button type="button" onClick={() => setCompatibility(value => !value)}>{compatibility ? "当前：兼容扫码 · 切换高清" : "识别不了？切换兼容扫码"}</button>}
      <button type="button" disabled={!ready && !cameraError} onClick={() => setScanType(type => type === "barcode" ? "qr" : "barcode")}>{scanType === "barcode" ? "当前：条码 · 切换二维码" : "当前：二维码 · 切换条码"}</button>
      <p role="status">{cameraError || (!ready ? "正在启动相机…" : scanType === "barcode" ? "全画面多方向识别 · 保持条码完整清晰，避开反光" : "全画面识别 · 保持二维码完整清晰")}</p>
      <button type="button" onClick={onClose}>关闭并手动输入</button>
    </footer>
  </div>, document.body)
}
export default ScannerModal
