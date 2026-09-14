function splitFaultCategoryPath(value) {
  const text = String(value || '').trim();
  const explicit = text.split(/\s+\/\s+|\|/).map(x => x.trim()).filter(Boolean);
  if (explicit.length >= 3) return explicit;
  const legacy = text.split('/').map(x => x.trim()).filter(Boolean);
  return legacy.length === 3 ? legacy : explicit;
}
module.exports = { splitFaultCategoryPath };
