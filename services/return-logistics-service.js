const fs = require('fs/promises');
const path = require('path');
class ReturnLogisticsService {
  constructor(file, read) { this.file=file; this.read=read; this.tail=Promise.resolve(); this.inflight=new Map(); this.job={running:false,total:0,done:0,failed:0}; this.autoStarting=false; }
  async all() { try { return JSON.parse(await fs.readFile(this.file,'utf8')); } catch(e) { if(e.code==='ENOENT') return {}; throw e; } }
  async save(rmaNo, value) {
    const work=this.tail.catch(()=>{}).then(async()=>{ const data=await this.all(); data[rmaNo]=value; await fs.mkdir(path.dirname(this.file),{recursive:true}); const tmp=this.file+'.tmp'; await fs.writeFile(tmp,JSON.stringify(data),{mode:0o600}); await fs.rename(tmp,this.file); }); this.tail=work; return work;
  }
  async decorate(rows) { const cache=await this.all(); return rows.map(order=>({...order,logisticsSyncing:this.inflight.has(order.rmaNo),recloudShipping:cache[order.rmaNo]?.sn===String(order.sn||'').replace(/\s/g,'').toUpperCase()?cache[order.rmaNo]:null})); }
  sync(order, includeTraces=true) {
    if(this.inflight.has(order.rmaNo)) return this.inflight.get(order.rmaNo);
    const task=(async()=>{
      const previous=(await this.all())[order.rmaNo]; const now=new Date().toISOString();
      try {
        const data=await this.read(order,{includeTraces});
        if(data.rmaNo!==order.rmaNo || data.sn!==String(order.sn||'').replace(/\s/g,'').toUpperCase()) throw new Error('同步结果与本地机器不一致');
        const same=previous?.trackingNo===data.trackingNo && previous?.sn===data.sn;
        const keepTraces=same && data.traceStatus!=='SUCCESS';
        const value={...data,...(keepTraces?{traces:previous.traces||[],signedAt:previous.signedAt||'',status:previous.status==='SIGNED'&&data.status==='SHIPPED'?'SIGNED':data.status}:{}),syncedAt:new Date().toISOString(),attemptedAt:now,error:''};
        await this.save(order.rmaNo,value); return value;
      } catch(e) { await this.save(order.rmaNo,{...(previous||{status:'UNKNOWN',sn:String(order.sn||'').replace(/\s/g,'').toUpperCase()}),attemptedAt:now,error:'瑞云物流查询未成功，请重试'}); throw e; }
    })().finally(()=>this.inflight.delete(order.rmaNo)); this.inflight.set(order.rmaNo,task); return task;
  }
  needsRefresh(order, cached, now=Date.now()) {
    if (this.inflight.has(order.rmaNo)) return false;
    if (!cached || cached.sn !== String(order.sn || '').replace(/\s/g,'').toUpperCase()) return true;
    // Back off failures and unavailable traces rather than retrying on every UI poll.
    const age=now-Date.parse(cached.attemptedAt || cached.syncedAt || '');
    if ((cached.error || cached.traceStatus === 'UNAVAILABLE') && age < 120000) return false;
    if (['SHIPPED','SIGNED'].includes(cached.status) && cached.traceStatus === 'NOT_LOADED') return true;
    return !Number.isFinite(age) || age >= (cached.status === 'SIGNED' ? 21600000 : 1800000);
  }
  async ensure(order) {
    const cached=(await this.all())[order.rmaNo];
    if (this.needsRefresh(order,cached)) this.sync(order,true).catch(()=>{});
  }
  async ensureAll(rows) {
    if(this.job.running || this.autoStarting) return;
    this.autoStarting=true;
    try { const cache=await this.all(); const due=rows.filter(order=>this.needsRefresh(order,cache[order.rmaNo])); if(due.length) this.start(due); }
    finally { this.autoStarting=false; }
  }
  start(rows) {
    if(this.job.running) return this.job;
    this.job={running:true,total:rows.length,done:0,failed:0,startedAt:new Date().toISOString()};
    this.work=(async()=>{ let consecutiveFailures=0; try { for(const order of rows) { try { await this.sync(order,true); consecutiveFailures=0; } catch { this.job.failed++; consecutiveFailures++; } this.job.done++; if(consecutiveFailures >= 3) { this.job.paused=true; break; } } } finally { this.job.running=false; this.job.finishedAt=new Date().toISOString(); } })();
    return this.job;
  }
}
module.exports={ReturnLogisticsService};
