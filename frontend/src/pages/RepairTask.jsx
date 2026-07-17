import {useState} from "react"


function RepairTask({order}){


const [signed,setSigned]=useState(false)



function getMachineType(sn){

 if(!sn)return ""

 const first=sn.substring(0,1)

 if(first==="W"){
  return "洗地机"
 }

 if(first==="R"){
  return "扫地机"
 }

 return "未知设备"

}



return (

<div className="page home-page">


<div className="card">


<h2>
签收寄修机器
</h2>



<div className="card machine-card">


<h3>
机器信息
</h3>


<p>
客户：
{order?.customer || "王先生"}
</p>


<p>
电话：
{order?.phone || "13688886666"}
</p>


<p>
型号：
{order?.model || "X2"}
</p>


<p>
SN：
{order?.sn || "R1234567A001"}
</p>


</div>





{
!signed ?


<div className="card">


<h3>
签收确认
</h3>



<div className="info-row">

<span>
SN核对
</span>


<span className="success">

已匹配

</span>


</div>




<div className="info-row">


<span>
签收明细备注
</span>


<span>

{
getMachineType(
order?.sn || "R1234567A001"
)

}

</span>


</div>




<button

className="primary-btn"

onClick={()=>setSigned(true)}

>

确认签收

</button>



</div>



:


<div className="card">


<h3>
✅ 签收完成
</h3>


<p>

CRM状态：
检测中

</p>



<button

className="primary-btn"

>

开始维修

</button>


</div>


}



</div>


</div>

)


}


export default RepairTask