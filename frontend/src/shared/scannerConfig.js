export function barcodeScanBox(width, height) {
  const boxWidth = Math.max(1, Math.floor(Math.min(width * 0.94, 680)))
  return { width: boxWidth, height: Math.max(1, Math.floor(Math.min(height * 0.65, boxWidth * 0.38))) }
}

export function qrScanBox(width, height) {
  const side = Math.max(1, Math.floor(Math.min(width, height, 360) * 0.8))
  return { width: side, height: side }
}

export const barcodeCameraConstraints = {
  facingMode: { ideal: "environment" },
  width: { ideal: 1920 },
  height: { ideal: 1080 },
}
