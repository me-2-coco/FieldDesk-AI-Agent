// Versioned, same-origin OCR assets: no photo or model requests to a CDN.
import { mkdir, copyFile } from 'node:fs/promises'
const root = new URL('../', import.meta.url)
const target = new URL('public/ocr/v7/', root)
await mkdir(target, { recursive: true })
for (const [source, name] of [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm', 'tesseract-core-lstm.wasm'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz'],
]) await copyFile(new URL(`node_modules/${source}`, root), new URL(name, target))
