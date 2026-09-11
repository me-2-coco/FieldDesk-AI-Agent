// Only UPLOAD_BUSY guarantees that the server has not accepted this file.
export async function retryBusyUpload(send, options = {}) {
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const random = options.random || Math.random
  const isCurrent = options.isCurrent || (() => true)
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!isCurrent()) throw new Error('登录状态已变化，已停止上传重试，请重新选择文件')
    try { return await send() }
    catch (error) {
      if (error?.status !== 503 || error?.code !== 'UPLOAD_BUSY') throw error
      if (attempt === 3) {
        error.message = '上传仍然繁忙，自动重试已停止，请稍后重新上传此文件'
        throw error
      }
      const seconds = Number(error.retryAfterSeconds)
      const delay = Math.max(3000, Math.min(30000, Number.isFinite(seconds) ? seconds * 1000 : 3000))
      await sleep(delay + Math.floor(random() * 1000))
    }
  }
}
