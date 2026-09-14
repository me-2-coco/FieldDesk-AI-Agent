// Suggestions only. Never replace ambiguous O/0, I/1, etc. automatically.
export function snTextCandidates(text) {
  const tokens = String(text).normalize('NFKC').toUpperCase().match(/[A-Z0-9]{10,32}/g) || []
  return [...new Set(tokens.filter(value => /[A-Z]/.test(value) && /[0-9]/.test(value)))]
}
