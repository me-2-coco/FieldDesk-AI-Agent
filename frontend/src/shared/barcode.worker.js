import { decodeBarcodeFrame, prepareBarcodeDecoder } from './barcodeDecoder.js'

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try { await prepareBarcodeDecoder(); self.postMessage({ type: 'ready' }) }
    catch { self.postMessage({ error: '条码识别器加载失败，请切换兼容扫码' }) }
    return
  }
  try { self.postMessage({ text: await decodeBarcodeFrame(data) }) }
  catch { self.postMessage({ error: '条码识别器加载失败，请关闭扫码重试' }) }
}
