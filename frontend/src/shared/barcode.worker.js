import { decodeBarcodeFrame, prepareBarcodeDecoder } from './barcodeDecoder.js'
let anglePass = 0

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    anglePass = 0
    try { await prepareBarcodeDecoder(); self.postMessage({ type: 'ready' }) }
    catch { self.postMessage({ error: '条码识别器加载失败，请切换兼容扫码' }) }
    return
  }
  try {
    const text = await decodeBarcodeFrame({ ...data, anglePass })
    // Keep the successful angle for the next frame's required confirmation.
    if (!text) anglePass = (anglePass + 1) % 35
    self.postMessage({ text })
  }
  catch { self.postMessage({ error: '条码识别器加载失败，请关闭扫码重试' }) }
}
