// Capture at camera resolution, independently of the CSS/display dimensions.
// Decode off the UI thread and never queue more than one camera frame.
export class FullFrameBarcodeScanner {
  constructor(areaId) { this.areaId = areaId; this.isScanning = false }
  async start(camera, config, onScan, onError) {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: config.videoConstraints, audio: false })
      this.video = document.createElement('video')
      this.video.muted = true
      this.video.autoplay = true
      this.video.playsInline = true
      this.video.srcObject = this.stream
      document.getElementById(this.areaId).append(this.video)
      await this.video.play()
      this.canvas = document.createElement('canvas')
      this.context = this.canvas.getContext('2d', { willReadFrequently: true })
      this.worker = new Worker(new URL('./barcode.worker.js', import.meta.url), { type: 'module' })
      this.isScanning = true
      this.worker.onmessage = ({ data }) => {
        if (!this.isScanning) return
        if (data.error) { void this.stop(); onError?.(data.error); return }
        if (data.text) { void onScan(data.text); return }
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
    this.worker.postMessage({ data: frame.data, width: frame.width, height: frame.height }, [frame.data.buffer])
  }
  getRunningTrackCapabilities() { return this.stream?.getVideoTracks()[0]?.getCapabilities?.() || {} }
  applyVideoConstraints(constraints) { return this.stream?.getVideoTracks()[0]?.applyConstraints(constraints) }
  async stop() {
    this.isScanning = false
    clearTimeout(this.timer)
    this.worker?.terminate()
    this.stream?.getTracks().forEach(track => track.stop())
    if (this.video) this.video.srcObject = null
  }
  clear() { this.video?.remove() }
}
