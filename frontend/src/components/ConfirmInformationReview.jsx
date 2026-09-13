import {useState} from 'react'
import {confirmInformationReview} from '../shared/crmService.js'
export default function ConfirmInformationReview({item,onUpdated}) {
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 async function confirm(){
  if(busy || !window.confirm(`确认 ${item.rmaNo} 的资料、附件及其他要求均已处理，并已在瑞云点击提交？\n确认后本条待办移入“已完成”，不代替瑞云提交，也不结束后续发货流程。`))return
  setBusy(true);setError('')
  try{await confirmInformationReview(item.rmaNo,item.reviewVersion);await onUpdated()}
  catch(e){setError(e.message)}finally{setBusy(false)}
 }
 return <div style={{padding:'0 14px 14px'}}><button type="button" className="primary-btn" style={{width:'100%',background:'#216ce0',color:'#fff',borderRadius:10,padding:'12px',fontSize:14,justifyContent:'center'}} onClick={confirm} disabled={busy}>{busy?'正在确认…':'确认已处理'}</button><small style={{display:'block',marginTop:6,color:'#64748b'}}>已在瑞云处理并提交后，再点击确认</small>{error && <p role="alert">{error}</p>}</div>
}
