const { isOwnerAccount } = require('../config/business-access-policy');
const canExportMonthly = user => user?.role === 'ADMIN' || isOwnerAccount(user || {});
const dayOf = value => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
function formalMonthlyOrders(orders, accounts) {
  const ids = new Set(accounts.filter(account => /^FieldDesk\d{4,}$/.test(account.userId || '') && account.userId !== 'FieldDesk0004' && !/TEST/i.test(account.accountPurpose || '')).map(account => account.userId));
  return orders.filter(order => ids.has(order.technicianId || order.operatorId));
}
function monthlyStatistics(orders, user, filters = {}) {
  const month = String(filters.month || dayOf(new Date()).slice(0,7));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Object.assign(new Error('请选择有效月份'),{status:400});
  const seen = new Set(), rows=[];
  for (const order of orders) {
    const id = String(order.technicianId || order.operatorId || '');
    if (!canExportMonthly(user) && id !== String(user.userId || user.id || '')) continue;
    const at = order.repairCompletion?.submittedAt || (['COMPLETED','REPAIR_COMPLETED_PENDING_SHIPMENT','SHIPPED_PENDING_COMPLETION'].includes(order.status) ? order.completedAt : '');
    if (!at || Number.isNaN(new Date(at).getTime()) || dayOf(at).slice(0,7)!==month || !order.rmaNo || seen.has(order.rmaNo)) continue;
    if (['ON_HOLD','TRANSFER_TO_HEADQUARTERS'].includes(order.treatmentMode)) continue;
    if (filters.technicianId && filters.technicianId!==id) continue;
    const product=order.productLine || order.specialty || '';
    if (filters.product && filters.product!==product) continue;
    seen.add(order.rmaNo);
    const abandoned=order.treatmentMode==='ABANDONED' || (!order.treatmentMode && /弃修/.test(order.repairCompletion?.repairMeasure || ''));
    rows.push({rmaNo:order.rmaNo,technicianId:id,technicianName:order.technicianName || order.operatorName || id,product,sn:order.sn || '',logisticsNo:order.logisticsNo || '',completedAt:at,day:dayOf(at),category:abandoned?'弃修':'维修',treatment:order.treatmentLabel || ({REPAIR:'维修',DEBUGGING:'调试',INSPECTION_ONLY:'只检测不维修',ABANDONED:'弃修'}[order.treatmentMode]) || (abandoned?'弃修':'维修')});
  }
  if (filters.includeDetails && canExportMonthly(user)) {
    const originals = new Map(orders.map(order => [order.rmaNo, order]));
    for (const row of rows) {
      const order = originals.get(row.rmaNo);
      row.customerName = order.customerName || '';
      row.phone = order.phone || order.phoneMasked || '';
      row.address = order.customerAddress || order.regionAddress || order.address || '';
      row.parts = order.repairCompletion?.usedParts || [];
    }
  }
  rows.sort((a,b)=>new Date(b.completedAt)-new Date(a.completedAt));
  const byPerson=new Map();
  for(const row of rows){const key=row.technicianId+'|'+row.product;if(!byPerson.has(key))byPerson.set(key,{technicianId:row.technicianId,technicianName:row.technicianName,product:row.product,repair:0,abandoned:0,total:0});const count=byPerson.get(key);count[row.category==='弃修'?'abandoned':'repair']++;count.total++;}
  const abandoned=rows.filter(r=>r.category==='弃修').length;
  return {month,canExport:canExportMonthly(user),summary:{repair:rows.length-abandoned,abandoned,total:rows.length},people:[...byPerson.values()],rows};
}
async function exportMonthly(data) {
  const ExcelJS=require('exceljs');
  const workbook=new ExcelJS.Workbook();
  const summary=workbook.addWorksheet('月度汇总');
  summary.columns=[{header:'月份',key:'month',width:14},{header:'师傅账号',key:'technicianId',width:22},{header:'师傅',key:'technicianName',width:24},{header:'品类',key:'product',width:16},{header:'维修',key:'repair',width:12},{header:'弃修',key:'abandoned',width:12},{header:'合计',key:'total',width:12}];
  data.people.forEach(row=>summary.addRow({...row,month:data.month}));
  summary.addRow({month:data.month,technicianName:'合计',...data.summary});
  const details=workbook.addWorksheet('工单明细');
  details.columns=[{header:'完成日期（北京时间）',key:'day',width:25},{header:'师傅账号',key:'technicianId',width:22},{header:'师傅',key:'technicianName',width:24},{header:'品类',key:'product',width:16},{header:'寄修单号',key:'rmaNo',width:26},{header:'物流单号',key:'logisticsNo',width:24},{header:'机器SN',key:'sn',width:28},{header:'统计分类',key:'category',width:14},{header:'实际处理方式',key:'treatment',width:22}];
  data.rows.forEach(row=>details.addRow({...row,day:new Date(Date.UTC(...row.day.split('-').map((n,i)=>Number(n)-(i===1?1:0))))}));
  details.getColumn('day').numFmt='yyyy-mm-dd';
  for (const [index, key, title, width] of [[10,'customerName','客户姓名',20],[11,'phone','联系电话',22],[12,'address','客户地址',48]]) {
    details.getColumn(index).header=title; details.getColumn(index).width=width;
    data.rows.forEach((row,i)=>{ details.getCell(i+2,index).value=String(row[key] || ''); });
  }
  const parts=workbook.addWorksheet('更换配件明细');
  parts.columns=[{header:'寄修单号',key:'rmaNo',width:26},{header:'产品线',key:'product',width:16},{header:'机器SN',key:'sn',width:28},{header:'物料编码',key:'partCode',width:24},{header:'配件名称',key:'partName',width:36},{header:'数量',key:'quantity',width:12},{header:'单价（已记录）',key:'unitPrice',width:20},{header:'金额',key:'amount',width:16}];
  const numberOrBlank=value=>value!=='' && value!=null && Number.isFinite(Number(value))?Number(value):null;
  data.rows.forEach(row=>(row.parts || []).forEach(part=>{
    const quantity=numberOrBlank(part.quantity), unitPrice=numberOrBlank(part.unitPrice ?? part.price);
    parts.addRow({rmaNo:row.rmaNo,product:row.product,sn:row.sn,partCode:String(part.partCode || part.code || ''),partName:part.partName || part.name || '',quantity,unitPrice,amount:quantity!==null && unitPrice!==null?quantity*unitPrice:null});
  }));
  parts.getColumn('unitPrice').numFmt='0.00'; parts.getColumn('amount').numFmt='0.00';
  for(const sheet of [summary,details,parts]){sheet.views=[{state:'frozen',ySplit:1}];sheet.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,sheet.rowCount),column:sheet.columnCount}};sheet.getRow(1).height=28;sheet.getRow(1).eachCell(cell=>{cell.font={bold:true,color:{argb:'FFFFFFFF'}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF2469BE'}}});}
  return workbook.xlsx.writeBuffer();
}
module.exports={monthlyStatistics,canExportMonthly,exportMonthly,formalMonthlyOrders};
