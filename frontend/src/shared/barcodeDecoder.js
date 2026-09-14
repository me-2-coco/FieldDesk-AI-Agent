import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'
import { rotateBarcodeFrame } from './rotateBarcodeFrame.js'
import { extractScannedIdentifier } from './queryIdentifier.js'

// Same-origin engine: camera frames stay on the device, with no CDN dependency.
prepareZXingModule({ overrides: { locateFile: () => wasmUrl } })
export function prepareBarcodeDecoder() {
  return prepareZXingModule({ overrides: { locateFile: () => wasmUrl }, fireImmediately: true })
}

async function readFrame(frame, formats, mode) {
  const results = await readBarcodes(frame, {
    formats, tryHarder: true, tryRotate: true,
    tryInvert: true, maxNumberOfSymbols: 5,
  })
  const candidates = [...new Set(results.filter(result => result.isValid)
    .map(result => extractScannedIdentifier(result.text, mode, /qr/i.test(result.format))).filter(Boolean))]
  return candidates.length === 1 ? candidates[0] : ''
}

export async function decodeBarcodeFrame(frame) {
  // An app-pairing QR can sit beside the machine's serial barcode. Decode the
  // linear symbols first so the QR cannot mask a valid SN in the same frame.
  const formats = frame.scannerMode === 'logistics' ? ['Code128', 'QRCode']
    : frame.scannerMode === 'sn' ? ['Linear-Codes'] : ['Linear-Codes', 'QRCode']
  const direct = await readFrame(frame, formats, frame.scannerMode)
  if (direct) return direct
  // Built-in tryRotate covers quarter turns, not arbitrary skew. Add diagonal
  // passes over the whole image. Never turn these into a cropped centre scan.
  for (const angle of [-45, -22.5, -67.5]) {
    const text = await readFrame(rotateBarcodeFrame(frame, angle), formats, frame.scannerMode)
    if (text) return text
  }
  return ''
}
