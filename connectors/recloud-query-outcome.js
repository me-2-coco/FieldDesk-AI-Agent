function containsExactValue(value, query) {
  if (typeof value === 'string') return value.trim() === query;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(item => containsExactValue(item, query));
}

function watchRmaQueryOutcome(page, query) {
  let missing = false;
  let stopped = false;
  const handler = async response => {
    try {
      const url = new URL(response.url());
      if (url.hostname !== 'crm2.recloud.com.cn' || !url.pathname.endsWith('/Rma/SearchRmaOrderMulti') || response.status() !== 200) return;
      const request = response.request();
      const raw = request.postData() || '';
      let matches = [...url.searchParams.values()].some(value => value === query);
      try { matches ||= containsExactValue(JSON.parse(raw), query); }
      catch { matches ||= [...new URLSearchParams(raw).values()].some(value => value === query); }
      if (!matches) return;
      const result = await response.json();
      if (!stopped && result?.ErrorCode === -1 && result.Data === null
        && /^无对应物流单号\/工单号\/订单号\/退换单号\/手机号\/设备序列号[!！]?$/.test(String(result.Message || '').trim())) missing = true;
    } catch { /* An unreadable response is not evidence of an absent order. */ }
  };
  page.on?.('response', handler);
  return {
    isMissing: () => missing,
    stop: () => { stopped = true; page.off?.('response', handler); },
  };
}

module.exports = { watchRmaQueryOutcome };
