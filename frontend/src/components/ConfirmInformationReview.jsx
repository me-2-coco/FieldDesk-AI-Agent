import {useState} from 'react'
import {confirmInformationReview} from '../shared/crmService.js'
import './confirm-information-review.css'
export default function ConfirmInformationReview({item,onUpdated}) {
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 async function confirm(){
  if(busy || !window.confirm(`确认 ${item.rmaNo} 的资料、附件及其他要求均已处理，并已在瑞云点击提交？\n确认后本条待办移入“已完成”，不代替瑞云提交，也不结束后续发货流程。`))return
  setBusy(true);setError('')
  try{await confirmInformationReview(item.rmaNo,item.reviewVersion);await onUpdated()}
  catch(e){setError(e.message)}finally{setBusy(false)}
 }
 return <div className="review-confirmation"><button type="button" className="review-confirmation-button" title="已在瑞云处理并提交后，再点击确认" onClick={confirm} disabled={busy}><span aria-hidden="true">✓</span>{busy?'正在确认…':'确认已处理'}</button>{error && <p className="review-confirmation-error" role="alert">{error}</p>}</div>
}
