import { useEffect, useRef, useState } from 'react'
import { snTextCandidates } from '../shared/snOcr.js'
import './scanner-modal.css'

export default function SnPhotoOcr({ onConfirm, onBack }) {
  const [photo, setPhoto] = useState('')
  const [angle, setAngle] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('只拍 SN 文字附近，保持清晰、避开反光。照片仅在本机处理。')
  const [value, setValue] = useState('')
  const [candidates, setCandidates] = useState([])
  const workerRef = useRef(null)
  const generation = useRef(0)
  const preview = useRef(null)
  useEffect(() => () => { generation.current++; void workerRef.current?.terminate() }, [])
  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo) }, [photo])
  const select = event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > 20 * 1024 * 1024) { setMessage('照片太大，请拍摄或选择小于 20MB 的图片'); return }
    setPhoto(URL.createObjectURL(file)); setAngle(0); setValue(''); setCandidates([])
    setMessage('检查照片方向，可旋转后识别。识别完成后请逐位核对 SN。')
  }
  const recognize = async () => {
    const id = ++generation.current
    setBusy(true); setValue(''); setCandidates([]); setMessage('正在加载本地识别引擎，首次使用可能较慢…')
    let worker
    const timeout = setTimeout(() => {
      if (generation.current !== id) return
      generation.current++; void workerRef.current?.terminate()
      setBusy(false); setMessage('识别超时，请重新拍照，或在下面手动填写 SN。')
    }, 90000)
    try {
      const image = preview.current
      if (!image?.naturalWidth) throw new Error('image')
      const canvas = document.createElement('canvas')
      const scale = Math.min(1, 2200 / Math.max(image.naturalWidth, image.naturalHeight))
      const w = Math.round(image.naturalWidth * scale), h = Math.round(image.naturalHeight * scale)
      canvas.width = angle % 180 ? h : w; canvas.height = angle % 180 ? w : h
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(angle * Math.PI / 180)
      ctx.drawImage(image, -w / 2, -h / 2, w, h)
      const { createWorker } = await import('tesseract.js')
      if (generation.current !== id) return
      worker = await createWorker('eng', 1, {
        workerPath: '/ocr/v7/worker.min.js', corePath: '/ocr/v7/tesseract-core-lstm.wasm.js', langPath: '/ocr/v7',
        logger: info => { if (generation.current === id && info.status === 'recognizing text') setMessage(`正在识别 SN… ${Math.round(info.progress * 100)}%`) },
      })
      if (generation.current !== id) return
      workerRef.current = worker
      await worker.setParameters({ tessedit_pageseg_mode: '11' })
      const { data } = await worker.recognize(canvas)
      if (generation.current !== id) return
      const found = snTextCandidates(data.text)
      setCandidates(found); setValue(found.length === 1 ? found[0] : '')
      setMessage(found.length ? '请对照照片逐位核对：结果可能漏字或认错，尤其 0/O、1/I、5/S、8/B；可直接修改。' : '未找到完整 SN，请重新拍照或手动填写。')
    } catch {
      if (generation.current === id) setMessage('照片识别失败，请重新拍照或手动填写 SN。')
    } finally {
      clearTimeout(timeout); await worker?.terminate(); workerRef.current = null
      if (generation.current === id) setBusy(false)
    }
  }
  const valid = /^[A-Za-z0-9-]{6,64}$/.test(value.trim())
  return <section className="fd-sn-photo">
    <h2>拍照识别 SN</h2>
    <p role="status">{message}</p>
    <label>拍照 / 选择照片<input aria-label="拍照或选择 SN 照片" type="file" accept="image/*" capture="environment" disabled={busy} onChange={select} /></label>
    {photo && <><img ref={preview} src={photo} alt="SN 标签原图，请对照核对" style={{ transform: `rotate(${angle}deg)` }} onError={() => setMessage('无法读取这张图片，请改用 JPG 或 PNG 照片')} />
      <div className="fd-sn-actions"><button type="button" disabled={busy} onClick={() => setAngle(a => (a + 90) % 360)}>旋转照片</button><button type="button" disabled={busy} onClick={recognize}>{busy ? '识别中…' : '识别文字'}</button></div></>}
    {candidates.length > 1 && <div className="fd-sn-actions">{candidates.map(item => <button type="button" key={item} onClick={() => setValue(item)}>{item}</button>)}</div>}
    <label>SN（请核对，可修改）<input value={value} disabled={busy} onChange={e => setValue(e.target.value)} autoCapitalize="characters" autoCorrect="off" spellCheck={false} placeholder="识别后核对，或手动填写" /></label>
    <p>确认仅填入 SN，不会自动签收。</p>
    <div className="fd-sn-actions"><button type="button" onClick={onBack}>返回扫码</button><button type="button" disabled={busy || !valid} onClick={() => onConfirm(value.trim())}>确认并填入 SN</button></div>
  </section>
}
