// Rotate the entire frame without cropping any edge. Runs only in the decoder
// worker after the normal pass fails; nearest-neighbour keeps narrow bars sharp.
export function rotateBarcodeFrame(frame, degrees) {
  const rad = degrees * Math.PI / 180
  const cos = Math.cos(rad), sin = Math.sin(rad)
  const width = Math.ceil(Math.abs(frame.width * cos) + Math.abs(frame.height * sin))
  const height = Math.ceil(Math.abs(frame.width * sin) + Math.abs(frame.height * cos))
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const dx = x - width / 2, dy = y - height / 2
    const sx = Math.round(dx * cos + dy * sin + frame.width / 2)
    const sy = Math.round(-dx * sin + dy * cos + frame.height / 2)
    if (sx < 0 || sy < 0 || sx >= frame.width || sy >= frame.height) continue
    const from = (sy * frame.width + sx) * 4, to = (y * width + x) * 4
    data[to] = frame.data[from]; data[to + 1] = frame.data[from + 1]; data[to + 2] = frame.data[from + 2]
  }
  return { data, width, height }
}
