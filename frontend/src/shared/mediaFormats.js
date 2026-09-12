import formats from "../../../shared/media-formats.json"

export const MEDIA_ACCEPT = Object.entries(formats.types).filter(([type]) => /^(image|video)\//.test(type)).flatMap(([type, extensions]) => [type, ...extensions.map(ext => `.${ext}`)]).join(",")
export function mediaType(file) {
  const raw = String(file.type || "").split(";")[0].trim().toLowerCase()
  const extension = String(file.name || "").split(".").pop().toLowerCase()
  const inferred = Object.entries(formats.types).find(([, extensions]) => extensions.includes(extension))?.[0]
  const type = formats.aliases[raw] || (["", "application/octet-stream", "binary/octet-stream"].includes(raw) ? inferred : raw)
  if (!type || !/^(image|video)\//.test(type) || !formats.types[type]?.includes(extension)) return ""
  return type
}
