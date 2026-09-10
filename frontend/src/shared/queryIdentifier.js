// Scanner symbology prefixes and non-printing separators are not part of the
// identifier. Never guess/correct visible letters or digits in a tracking code.
export function normalizeQueryIdentifier(value) {
  return String(value ?? '').normalize('NFKC')
    .replace(/^\][A-Za-z][0-9]/, '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .trim()
}

export function isPlausibleScannedIdentifier(value) {
  const text = normalizeQueryIdentifier(value)
  if (/^SF/i.test(text)) return /^SF\d{10,16}$/i.test(text)
  return /^[A-Za-z0-9-]{6,64}$/.test(text)
}

export function extractScannedIdentifier(value, mode = 'logistics', isQr = false) {
  const text = normalizeQueryIdentifier(value)
  if (isPlausibleScannedIdentifier(text) && (!isQr || mode !== 'logistics' || /^SF\d{10,16}$/i.test(text))) return text
  if (mode !== 'logistics') return ''
  let payload = text
  try { payload = decodeURIComponent(text) } catch { /* Not URL encoded. */ }
  const matches = [...payload.matchAll(/(?:^|[^A-Za-z0-9])(SF\d{10,16})(?=$|[^A-Za-z0-9])/gi)]
  const unique = [...new Set(matches.map(match => match[1].toUpperCase()))]
  // A QR payload can contain URLs, addresses, or multiple waybills. Never query
  // the whole payload or pick an arbitrary tracking number from it.
  return unique.length === 1 ? unique[0] : ''
}
