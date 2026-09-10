// Capture at camera resolution, independently of the CSS/display dimensions.
// Decode off the UI thread and never queue more than one camera frame.
export class FullFrameBarcodeScanner {
  constructor(areaId, mode = 'logistics') { this.areaId = areaId; this.mode = mode; this.isScanning = false }
  async start(camera, config, onScan, onError) {
    this.onStalled = onError
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: config.videoConstraints, audio: false })
      this.video = document.createElement('video')
      this.video.muted = true
      this.video.autoplay = true
      this.video.playsInline = true
      this.video.srcObject = this.stream
      document.getElementById(this.areaId).append(this.video)
      await this.withTimeout(this.video.play(), '相机画面未就绪，请切换兼容扫码')
      this.canvas = document.createElement('canvas')
      this.context = this.canvas.getContext('2d', { willReadFrequently: true })
      this.worker = new Worker(new URL('./barcode.worker.js', import.meta.url), { type: 'module' })
      await this.withTimeout(new Promise((resolve, reject) => {
        this.worker.onmessage = ({ data }) => {
          if (data.type === 'ready') resolve()
          else if (data.error) reject(new Error(data.error))
        }
        this.worker.onerror = () => reject(new Error('识别器启动失败，请切换兼容扫码'))
        this.worker.postMessage({ type: 'init' })
      }), '识别器启动超时，请切换兼容扫码')
      this.isScanning = true
      this.worker.onmessage = async ({ data }) => {
        clearTimeout(this.decodeTimer)
        if (!this.isScanning) return
        if (data.error) { void this.stop(); onError?.(data.error); return }
        if (data.text && await onScan(data.text) !== false) return
        if (!this.isScanning) return
        this.timer = setTimeout(() => this.capture(), 50)
      }
      this.worker.onerror = () => {
        void this.stop()
        onError?.('条码识别器加载失败，请关闭扫码重试')
      }
      this.capture()
    } catch (error) { await this.stop(); throw error }
  }
  capture() {
    if (!this.isScanning) return
    if (!this.video.videoWidth || !this.video.videoHeight) {
      this.timer = setTimeout(() => this.capture(), 50)
      return
    }
    const scale = Math.min(1, 1920 / Math.max(this.video.videoWidth, this.video.videoHeight))
    this.canvas.width = Math.max(1, Math.round(this.video.videoWidth * scale))
    this.canvas.height = Math.max(1, Math.round(this.video.videoHeight * scale))
    this.context.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height)
    const frame = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height)
    this.decodeTimer = setTimeout(() => {
      void this.stop()
      this.onStalled?.('识别线程无响应，请切换兼容扫码')
    }, 5000)
    this.worker.postMessage({ data: frame.data, width: frame.width, height: frame.height, scannerMode: this.mode }, [frame.data.buffer])
  }
  getRunningTrackCapabilities() { return this.stream?.getVideoTracks()[0]?.getCapabilities?.() || {} }
  async withTimeout(promise, message) {
    let timer
    try {
      return await Promise.race([promise, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 8000)
      })])
    } finally { clearTimeout(timer) }
  }
  applyVideoConstraints(constraints) { return this.stream?.getVideoTracks()[0]?.applyConstraints(constraints) }
  async stop() {
    this.isScanning = false
    clearTimeout(this.timer)
    clearTimeout(this.decodeTimer)
    this.worker?.terminate()
    this.stream?.getTracks().forEach(track => track.stop())
    if (this.video) this.video.srcObject = null
  }
  clear() { this.video?.remove() }
}
