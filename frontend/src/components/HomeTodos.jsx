import { useEffect, useState } from 'react'
import { getHomeTodos } from '../shared/crmService.js'
import './home-todos.css'

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
  const items=(data?.items || []).filter(i=>!selected || selected==='all' || i.group===selected)
  const visible=selected?items:items.slice(0,3)
  return <section className="card home-todos">
    <header><div><h2>待办提醒</h2><small>{technician?'仅本人相关工单':'网点待处理事项'} · 按工单计数</small></div>{selected?<button onClick={()=>setSelected('')}>收起</button>:<button onClick={()=>setSelected('all')}>查看全部 ›</button>}</header>
    {error && <p role="alert" className="error-text">待办更新失败：{error}，稍后自动重试</p>}
    {!data && !error && <p>正在读取待办…</p>}
    {data && <><div className="todo-grid">{data.groups.map(g=><button key={g.id} className={selected===g.id?'active':''} onClick={()=>setSelected(g.id)}><span>{g.label}</span><strong>{g.count}<small> 单</small></strong></button>)}</div>
      {!items.length && !error && <p className="todo-empty">{selected?'该分类暂无待处理事项':'当前暂无待处理事项'}</p>}
      {!!visible.length && <div className="todo-list" aria-label="待办列表">{visible.map(i=><button key={i.id} onClick={()=>onOpen(i)}><span><small>{data.groups.find(g=>g.id===i.group)?.label} · {i.technicianName}</small><strong>{i.rmaNo || '后台任务'}</strong><em>{i.message}</em></span><b>›</b></button>)}</div>}
    </>}
  </section>
}
