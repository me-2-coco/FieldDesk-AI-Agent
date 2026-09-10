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
