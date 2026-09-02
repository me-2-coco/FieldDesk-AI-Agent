import { useEffect, useState } from "react"

function AttachmentPreviewItem({ attachment, loadAttachment, onRemove, disabled, onPreview }) {
  const [sourceUrl, setSourceUrl] = useState("")
  const [loadError, setLoadError] = useState("")
  const mimeType = String(attachment.mimeType || "")
  const localFile = attachment.file || attachment.localPreviewFile

  useEffect(() => {
    let active = true
    let objectUrl = ""
    const preparePreview = async () => {
      try {
        const blob = localFile || (loadAttachment ? (await loadAttachment(attachment)).blob : null)
        if (!blob || !active) return
        objectUrl = URL.createObjectURL(blob)
        setSourceUrl(objectUrl)
      } catch (error) {
        if (active) setLoadError(error.message || "预览加载失败")
      }
    }
    preparePreview()
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment, loadAttachment, localFile])

  const isImage = mimeType.startsWith("image/")
  const isVideo = mimeType.startsWith("video/")
  const isPdf = mimeType === "application/pdf"

  return (
    <article className="attachment-preview-item">
      <div className="attachment-preview-media">
        {isImage && sourceUrl ? (
          <button type="button" className="attachment-image-button" onClick={() => onPreview({ ...attachment, sourceUrl })} aria-label={`放大查看${attachment.name}`}>
            <img src={sourceUrl} alt={attachment.name || "附件照片"} />
            <span>点击放大</span>
          </button>
        ) : isVideo && sourceUrl ? (
          <video src={sourceUrl} controls playsInline preload="metadata" aria-label={attachment.name || "附件视频"} />
        ) : isPdf && sourceUrl ? (
          <a className="attachment-file-tile" href={sourceUrl} target="_blank" rel="noreferrer">PDF</a>
        ) : (
          <div className="attachment-preview-loading">{loadError ? "无法预览" : "加载中"}</div>
        )}
      </div>
      <div className="attachment-preview-meta">
        <span>{isPdf ? "报告" : isVideo ? "视频" : "照片"}</span>
        <strong title={attachment.name}>{attachment.name}</strong>
        {loadError && <small>{loadError}</small>}
      </div>
      {onRemove && <button type="button" className="attachment-remove-button" onClick={() => onRemove(attachment.id)} disabled={disabled} aria-label={`移除${attachment.name}`}>移除</button>}
    </article>
  )
}

function AttachmentPreviewList({ attachments, loadAttachment, onRemove, disabled = false }) {
  const [preview, setPreview] = useState(null)

  useEffect(() => {
    if (!preview) return undefined
    const closeOnEscape = (event) => event.key === "Escape" && setPreview(null)
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [preview])

  return <>
    <div className="attachment-preview-list">
      {attachments.map((attachment) => <AttachmentPreviewItem key={attachment.id} attachment={attachment} loadAttachment={loadAttachment} onRemove={attachment.uploaded ? null : onRemove} disabled={disabled} onPreview={setPreview} />)}
    </div>
    {preview && <div className="attachment-lightbox" role="dialog" aria-modal="true" aria-label={`查看${preview.name}`} onClick={() => setPreview(null)}>
      <div className="attachment-lightbox-content" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="attachment-lightbox-close" onClick={() => setPreview(null)} aria-label="关闭图片预览">×</button>
        <img src={preview.sourceUrl} alt={preview.name || "附件大图"} />
        <p>{preview.name}</p>
      </div>
    </div>}
  </>
}

export default AttachmentPreviewList
