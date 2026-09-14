// Read-only inbound synchronization. Never clicks shipping, label or save actions.
const LIST_URL = 'https://crm2.recloud.com.cn/t/dreame/webapp/dreame/?mainNavName=serviceprovider#/vmlist/new_srv_rmaline/wdjx';
const clean = value => /^(?:--?|null|undefined)?$/.test(String(value || '').trim()) ? '' : String(value).trim();
function parseReturnRow(row, order) {
  if (clean(row['寄修单号']) !== order.rmaNo || (clean(row['RMA单号']) && clean(row['RMA单号']) !== order.rmaNo)) throw new Error('瑞云寄修单号不匹配');
  const sn = clean(row['产品序列号']).replace(/\s/g, '').toUpperCase();
  if (!sn || !order.sn || sn !== order.sn.replace(/\s/g, '').toUpperCase()) throw new Error('瑞云机器 SN 不匹配或缺失，需核对');
  const rawStatus = clean(row['发货物流状态']);
  // A label number alone does not establish that a parcel has shipped.
  const status = rawStatus === '已签收' ? 'SIGNED' : /^(已发货|已寄出|运输中|派送中|已签收)$/.test(rawStatus) ? 'SHIPPED' : /^(待发货|未发货|待下单|未下单|待打印面单|已下单)$/.test(rawStatus) ? 'PENDING' : 'UNKNOWN';
  return { rmaNo: order.rmaNo, sn, status, rawStatus, orderStatus: clean(row['寄修单处理状态']), logisticsCompany: clean(row['物流公司']), trackingNo: clean(row['物流单号']), shippedAt: clean(row['发货时间']), traces: [], traceStatus: 'NOT_LOADED', source: 'RECLOUD' };
}
async function rowsFromPage(page) {
  return page.evaluate(() => {
    const tables = [...document.querySelectorAll('table')];
    const headers = tables.map(t => [...t.querySelectorAll('th')].map(c => c.textContent.trim())).sort((a,b)=>b.length-a.length).find(h => h.includes('发货物流状态') && h.includes('物流单号'));
    if (!headers) return [];
    const table = tables.find(t => t.querySelector('tbody tr')?.querySelectorAll('td').length === headers.length || t.querySelector('tbody tr')?.querySelectorAll('td').length === headers.length - 1);
    return table ? [...table.querySelectorAll('tbody tr')].map(tr => Object.fromEntries(headers.map((h,i)=>[h,tr.querySelectorAll('td')[i]?.textContent.trim() || '']))) : [];
  });
}
async function selectView(page, label) {
  const more = page.locator('#tab-more');
  await more.waitFor({state:'visible',timeout:15000});
  await more.click();
  await page.getByText(label, {exact:true}).filter({visible:true}).click();
  await page.waitForFunction(label => document.querySelector('#tab-more')?.textContent.includes(label) && document.querySelector('#tab-more')?.getAttribute('aria-selected') === 'true', label, {timeout:15000});
}
async function search(page, rmaNo) {
  const input = page.getByPlaceholder('产品序列号/RMA单号', {exact:true});
  await input.fill(rmaNo); await input.press('Enter');
  await page.waitForFunction(rma => [...document.querySelectorAll('table tbody tr')].some(tr => [...tr.querySelectorAll('td')].some(c=>c.textContent.trim()===rma)) && ![...document.querySelectorAll('.el-loading-mask')].some(e=>e.getBoundingClientRect().height>0), rmaNo, {timeout:20000});
  const rows = (await rowsFromPage(page)).filter(row => row['寄修单号'] === rmaNo);
  if (rows.length !== 1) throw new Error('瑞云未返回唯一寄修记录，请稍后重试');
  return rows[0];
}
async function readReturnLogistics(page, order, {includeTraces=false}={}) {
  await page.goto(LIST_URL, {waitUntil:'domcontentloaded'});
  await selectView(page, '网点寄修明细');
  await page.getByRole('columnheader',{name:'寄修单处理状态',exact:true}).first().waitFor({state:'visible',timeout:15000});
  const result = parseReturnRow(await search(page, order.rmaNo), order);
  if (!['SHIPPED','SIGNED'].includes(result.status)) return result;
  try {
    await selectView(page, '网点已发货');
    // Wait for the shipped view's own columns, not the old table.
    await page.getByRole('columnheader',{name:'发货时间',exact:true}).first().waitFor({state:'visible',timeout:15000});
    const shipped = parseReturnRow(await search(page, order.rmaNo), order);
    if (shipped.trackingNo !== result.trackingNo) throw new Error('返件运单发生变化，请重新同步');
    result.shippedAt = shipped.shippedAt;
    if (!includeTraces || !result.trackingNo) return result;
    const row = page.locator('table.el-table__body tr').filter({hasText:order.rmaNo}).filter({has:page.getByRole('button',{name:'物流查询',exact:true})}).first();
    await row.getByRole('button',{name:'物流查询',exact:true}).click();
    const title = page.locator('.rt-dialog-title-wrapper').filter({hasText:'查看物流'});
    await title.waitFor({state:'visible',timeout:10000});
    await page.locator('.el-timeline-item:visible').first().waitFor({state:'visible',timeout:15000});
    result.traces = await page.locator('.el-timeline-item:visible').allTextContents().then(items=>items.map(text=>{
      const match = text.trim().match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*([\s\S]*)/);
      return match ? {at:match[1],description:match[2].trim()} : null;
    }).filter(Boolean));
    result.traceStatus = result.traces.length ? 'SUCCESS' : 'UNAVAILABLE';
    await title.locator('.rt-base-close-x-lined').click();
  } catch {
    result.traceStatus = includeTraces ? 'UNAVAILABLE' : 'NOT_LOADED';
  }
  // The generic "物流签收时间" column may refer to inbound pickup. Use only return traces.
  const signed = result.traces.find(t=>/(?:已签收|签收成功|本人签收|签收人)/.test(t.description) && !/(?:未签收|拒签|待签收)/.test(t.description));
  if (signed) { result.status='SIGNED'; result.signedAt=signed.at; }
  return result;
}
module.exports = {parseReturnRow,readReturnLogistics};
