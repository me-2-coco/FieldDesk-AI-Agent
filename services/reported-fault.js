function resolveReportedFault(rmaNo, sources = []) {
  return String(sources.find(item => String(item?.rmaNo || '').trim() === String(rmaNo || '').trim()
    && String(item.reportedFault || '').trim())?.reportedFault || '').trim();
}
module.exports = { resolveReportedFault };
