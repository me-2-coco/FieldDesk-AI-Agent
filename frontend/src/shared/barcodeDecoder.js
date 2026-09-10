import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'
import { rotateBarcodeFrame } from './rotateBarcodeFrame.js'

// Same-origin engine: camera frames stay on the device, with no CDN dependency.
prepareZXingModule({ overrides: { locateFile: () => wasmUrl } })
export function prepareBarcodeDecoder() {
  return prepareZXingModule({ overrides: { locateFile: () => wasmUrl }, fireImmediately: true })
}

async function readFrame(frame) {
  const results = await readBarcodes(frame, {
    formats: ['Linear-Codes'], tryHarder: true, tryRotate: true,
    tryInvert: true, maxNumberOfSymbols: 1,
  })
  return results.find(result => result.isValid && result.text)?.text || ''
}

export async function decodeBarcodeFrame(frame) {
  const direct = await readFrame(frame)
  if (direct) return direct
  // Built-in tryRotate covers quarter turns, not arbitrary skew. Add diagonal
  // passes over the whole image. Never turn these into a cropped centre scan.
  for (const angle of [-45, -22.5, -67.5]) {
    const text = await readFrame(rotateBarcodeFrame(frame, angle))
    if (text) return text
  }
  return ''
}
