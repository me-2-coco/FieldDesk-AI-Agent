import {useRef,useState} from 'react'
import {recordPaymentFollowup,syncPaymentFollowup} from '../shared/crmService.js'
export default function PaymentFollowup({item,onUpdated}) {
  const [note,setNote]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const attempt=useRef(null)
  const sync=async id=>{
    setBusy(true)
    try {await syncPaymentFollowup(item.rmaNo,id);setMessage('备注已同步瑞云');await onUpdated()}
    catch(e){setMessage(`跟进记录仍保留，备注同步未确认：${e.message}`)}
    finally{setBusy(false)}
  }
  const save=async paid=>{
    if(!note.trim()) {setMessage('请填写本次跟进备注');return}
    if(paid && !window.confirm('确认费用已经实际收到？确认后将通知原师傅继续维修，不自动提交瑞云。')) return
    setBusy(true)
    try {
      if(!attempt.current) attempt.current={id:crypto.randomUUID(),rmaNo:item.rmaNo,holdRequestedAt:item.payment.holdRequestedAt,paid,note:note.trim()}
      const input=attempt.current
      await recordPaymentFollowup(input)
      attempt.current=null;setNote('');setMessage('跟进已保存，正在同步备注')
      await syncPaymentFollowup(item.rmaNo,input.id)
      setMessage('跟进已保存，备注已同步瑞云')
    } catch(e){setMessage(`请查看记录后再操作：${e.message}`)}
    finally{await onUpdated();setBusy(false)}
  }
  return <div className="payment-followup">
    <details><summary>工单备注与跟进记录</summary><p style={{whiteSpace:'pre-wrap'}}>{item.payment.remark || '暂无备注'}</p></details>
    {item.payment.entries.filter(e=>e.syncStatus!=='CONFIRMED').map(e=><button type="button" key={e.id} disabled={busy} onClick={()=>sync(e.id)}>核对并同步未完成备注（{e.at.slice(0,16)}）</button>)}
    {!item.payment.paid && <><label>追加跟进备注<textarea maxLength={1500} value={note} disabled={busy || !!attempt.current} onChange={e=>setNote(e.target.value)} placeholder="例如：已联系用户，用户仍在考虑，费用未收到" /></label>
    <button type="button" disabled={busy} onClick={()=>save(false)}>费用未收到，保存跟进</button>
    <button type="button" disabled={busy} onClick={()=>save(true)}>费用已收到，通知师傅</button></>}
    {message && <p role="status">{message}</p>}
  </div>
}
