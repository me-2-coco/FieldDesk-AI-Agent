export function supportsTorch(track) {
  try {
    const capability = track?.getCapabilities?.().torch
    return track?.readyState === "live" && (capability === true || (Array.isArray(capability) && capability.includes(true)))
  } catch { return false }
}

export async function setCameraTorch(track, enabled) {
  if (!supportsTorch(track)) throw new Error("当前摄像头或浏览器不支持补光灯")
  const constraints = track.getConstraints?.() || {}
  const advanced = (constraints.advanced || []).map(item => {
    const copy = { ...item }
    delete copy.torch
    return copy
  })
  await track.applyConstraints({ ...constraints, torch: enabled, advanced: [...advanced, { torch: enabled }] })
  const actual = track.getSettings?.().torch
  if (typeof actual !== "boolean" || actual !== enabled) throw new Error("无法确认补光灯状态，请使用系统相机或外部照明")
  return actual
}
