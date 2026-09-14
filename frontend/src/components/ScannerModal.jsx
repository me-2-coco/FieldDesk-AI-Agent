import { useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Html5Qrcode, Html5QrcodeSupportedFormats as Formats } from "html5-qrcode"
import { fullFrameScanConfig, enableContinuousFocus } from "../shared/scannerConfig.js"
import { FullFrameBarcodeScanner } from "../shared/FullFrameBarcodeScanner.js"
import { extractScannedIdentifier } from '../shared/queryIdentifier.js'
import "./scanner-modal.css"
import CameraTorchButton from "./CameraTorchButton.jsx"

function ScannerModal({ open, mode = "logistics", title = "扫码", onScan, onClose }) {
  const areaId = `scanner-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const callbacks = useRef({ onScan, onClose })
  const shutdown = useRef(Promise.resolve())
  const [cameraError, setCameraError] = useState("")
  const [ready, setReady] = useState(false)
  const [cameraTrack, setCameraTrack] = useState(null)
  const [compatibility, setCompatibility] = useState(mode !== 'sn')
  const [zoom, setZoom] = useState(1)
  const zoomCapability = cameraTrack?.getCapabilities?.().zoom
  const changeZoom = async () => {
    const next = zoom === 1 ? Math.min(2, zoomCapability?.max || 1) : 1
    try {
      await cameraTrack.applyConstraints({ advanced: [{ zoom: Math.max(zoomCapability?.min || 1, next) }] })
      setZoom(next)
    } catch { setCameraError('当前相机不支持放大，请调整手机与条码的距离') }
  }
  useEffect(() => { callbacks.current = { onScan, onClose } }, [onScan, onClose])
  useEffect(() => {
    if (!open) return
    let active = true
    let scanner
    let starting
    let stopping
    let decoded = false
    let lastCandidate = ''
    let confirmations = 0
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
      setCameraTrack(null)
      setZoom(1)
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError("当前浏览器无法调用相机，请使用已信任证书的 HTTPS 地址")
        return
      }
      scanner = !compatibility ? new FullFrameBarcodeScanner(areaId, mode)
        : new Html5Qrcode(areaId, { formatsToSupport: mode === 'logistics' ? [Formats.CODE_128, Formats.QR_CODE]
          : [...(mode === 'sn' ? [] : [Formats.QR_CODE]), Formats.CODE_128, Formats.CODE_39, Formats.CODE_93, Formats.ITF, Formats.CODABAR, Formats.EAN_13, Formats.EAN_8, Formats.UPC_A, Formats.UPC_E] })
      starting = scanner.start({ facingMode: "environment" }, fullFrameScanConfig, async (text, result) => {
        if (!active || decoded) return
        const isQr = /qr/i.test(String(result?.result?.format?.formatName || ''))
        const candidate = extractScannedIdentifier(text, mode, isQr)
        {
          if (!candidate) {
            lastCandidate = ''; confirmations = 0
            return false
          }
          confirmations = candidate === lastCandidate ? confirmations + 1 : 1
          lastCandidate = candidate
          if (confirmations < 2) return false
        }
        decoded = true
        await stop()
        if (active) {
          callbacks.current.onScan(candidate)
          callbacks.current.onClose()
        }
      }, error => { if (active && !compatibility) setCameraError(String(error)) })
      starting.then(() => {
        if (active) {
          setReady(true)
          setCameraTrack(document.getElementById(areaId)?.querySelector("video")?.srcObject?.getVideoTracks()[0] || null)
          void enableContinuousFocus(scanner)
        }
        else void stop()
      }).catch(error => {
        if (active && !compatibility) setCompatibility(true)
        else if (active) setCameraError(`相机启动失败：${error?.message || String(error)}。请关闭重试或手动输入。`)
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
  }, [areaId, mode, open, compatibility])
  if (!open) return null
  return createPortal(<div className="fd-scanner-overlay" role="dialog" aria-modal="true" aria-label={title}>
    <header className="fd-scanner-header">
      <button className="fd-camera-close" type="button" aria-label="关闭扫码" onClick={onClose}><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
      <strong>{title}</strong>
      {ready ? <CameraTorchButton key={cameraTrack?.id || "unavailable"} track={cameraTrack} /> : <span />}
    </header>
    <div className="fd-scanner-view" id={areaId} />
    <footer className="fd-scanner-footer">
      <div className="fd-scanner-mode">{mode === 'sn' ? '扫描机器 SN 条码' : '扫码'}</div>
      {ready && zoomCapability?.max > 1 && <button type="button" onClick={changeZoom} aria-label="切换相机放大倍数">{zoom === 1 ? '放大条码 2×' : '恢复 1×'}</button>}
      <p role="status">{cameraError || (!ready ? "正在启动相机…" : mode === 'sn' ? "对准 S/N 旁边的长条码，保持两端完整；稍微离远，让画面清晰" : "对准条码或二维码，即可自动识别")}</p>
      <details className="fd-scanner-help">
        <summary>识别帮助</summary>
        <p>保持条码完整清晰，避开反光；光线不足时可打开右上角补光灯。</p>
        <button type="button" onClick={() => setCompatibility(value => !value)}>{compatibility ? "切换高清识别" : "切换兼容识别"}</button>
      </details>
    </footer>
  </div>, document.body)
}
export default ScannerModal
