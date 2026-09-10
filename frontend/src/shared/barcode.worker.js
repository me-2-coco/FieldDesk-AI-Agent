import { decodeBarcodeFrame } from './barcodeDecoder.js'

self.onmessage = async ({ data }) => {
  try { self.postMessage({ text: await decodeBarcodeFrame(data) }) }
  catch { self.postMessage({ error: '条码识别器加载失败，请关闭扫码重试' }) }
}
