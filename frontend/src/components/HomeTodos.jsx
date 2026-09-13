import { useEffect, useState } from 'react'
import { getHomeTodos } from '../shared/crmService.js'
import './home-todos.css'
import PaymentFollowup from './PaymentFollowup.jsx'
import ConfirmInformationReview from './ConfirmInformationReview.jsx'

export default function HomeTodos({onOpen, technician}) {
  const [data,setData]=useState(null)
  const [error,setError]=useState('')
  const [selected,setSelected]=useState('')
  useEffect(()=>{
    let active=true, timer
    const refresh=async()=>{
      try {const result=await getHomeTodos();if(active){setData(result);setError('')}}
      catch(e){if(active)setError(e.message)}
      finally {if(active)timer=setTimeout(refresh,30000)}
    }
    refresh();return()=>{active=false;clearTimeout(timer)}
  },[])
  const activeGroup=selected || data?.groups.find(g=>g.count>0)?.id || data?.groups[0]?.id
  const items=(data?.items || []).filter(i=>activeGroup==='all' || i.group===activeGroup)
  const label=data?.groups.find(g=>g.id===activeGroup)?.label || '全部消息'
  return <section className="card home-todos">
    <header><div><h2>消息与待办</h2><small>{technician?'仅本人相关工单':'按业务分类 · 点击分类查看'} · 按工单计数</small></div><button onClick={()=>setSelected(activeGroup==='all'?'':'all')}>{activeGroup==='all'?'分类查看':'全部消息'}</button></header>
    {error && <p role="alert" className="error-text">待办更新失败：{error}，稍后自动重试</p>}
    {!data && !error && <p>正在读取待办…</p>}
    {data && <><div className="todo-grid">{data.groups.map(g=><button type="button" key={g.id} aria-pressed={activeGroup===g.id} className={`todo-category category-${g.id} ${activeGroup===g.id?'active':''}`} onClick={()=>setSelected(g.id)}><span>{g.label}</span><strong>{g.count}<small> 单</small></strong></button>)}</div>
      <div className="todo-list-heading"><strong>{label}</strong><small>{items.length} 条提醒 · 列表可上下滑动</small></div>
      {!items.length && !error && <p className="todo-empty">{selected?'该分类暂无待处理事项':'当前暂无待处理事项'}</p>}
      {!!items.length && <div className="todo-list" aria-label={`${label}列表`} key={activeGroup}>{items.map(i=><div key={i.id}>
        <article className={`todo-message category-${i.group}`}>
          <div className="todo-message-heading">
            <small className="todo-message-tag">{data.groups.find(g=>g.id===i.group)?.label}</small>
            {i.reviewVersion && !technician && <ConfirmInformationReview item={i} onUpdated={async()=>setData(await getHomeTodos())}/>}
          </div>
          <button type="button" className="todo-open" onClick={()=>onOpen(i)}><span><strong>{i.rmaNo || '后台任务'}</strong><small>负责师傅：{i.technicianName || '未记录'}</small><em>{i.message}</em><small className="todo-next-action">下一步：{i.action || '查看详情'}</small></span><b aria-hidden="true">›</b></button>
        </article>
        {i.payment && !technician && <PaymentFollowup item={i} onUpdated={async()=>setData(await getHomeTodos())}/>}
      </div>)}</div>}
    </>}
  </section>
}
