// Reduce both network hops while retaining all pixels and the full watermark.
// Existing stored attachments and their stable identities are never changed.
export async function optimizeUploadPhoto(file) {
  if (file.type !== "image/jpeg" || file.size < 1024 * 1024) return file
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    await new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = reject
      image.src = url
    })
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 24000000) return file
    const canvas = document.createElement("canvas")
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    try {
      canvas.getContext("2d").drawImage(image, 0, 0)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85))
      if (!blob?.size || blob.size > file.size * 0.9) return file
      return new File([blob], file.name, { type: "image/jpeg", lastModified: file.lastModified })
    } finally {
      canvas.width = canvas.height = 0
    }
  } catch {
    return file
  } finally {
    URL.revokeObjectURL(url)
  }
}
