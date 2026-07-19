import {useState} from "react"


function RepairFinish({setPage}){


const [repairOrder,setRepairOrder]=useState(()=>{

const data=localStorage.getItem("currentRepair")

return data ? JSON.parse(data):{}

})





function submitRepair(){


const update={

...repairOrder,

status:"待提交"

}


localStorage.setItem(

"currentRepair",

JSON.stringify(update)

)


setRepairOrder(update)


setPage("home")


}







return(


<div className="page repair-finish-page">



{/* 顶部 */}

<div className="top-bar">


<button

className="arrow-back"

onClick={()=>setPage("repairWork")}

>

←

</button>


<h1>

提交确认

</h1>


</div>







{/* 机器信息 */}

<div className="card report-card machine-info-card">



<div className="machine-card-header">


<h2>
📦机器信息
</h2>



<span className="repair-status-badge status-working">
维修完成
</span>


</div>





<div className="machine-info-list">


<p>
客户： {repairOrder.customer || "王先生"}
</p>


<p>
电话： {repairOrder.phone || "13688886666"}
</p>


<p>
产品： {repairOrder.product || "扫地机器人X2"}
</p>


<p>
序列号： {repairOrder.sn || "123"}
</p>


<p>
物流单号：
{repairOrder.logisticsNo || "SF202607160001"}

</p>



<p>
CRM编号：
{repairOrder.crmNo || "CRM-20260716001"}

</p>



</div>


</div>









<div className="card report-card">


<h2>

🔧 故障描述

</h2>


<p>

{repairOrder.fault || "机器运行时异响"}

</p>


</div>









<div className="card report-card">


<h2>

🧩 故障分类

</h2>



<p>

{

repairOrder.faultCategory || "未选择"

}

</p>



</div>









<div className="card report-card">


<h2>

🛠维修措施

</h2>



<p>

{

repairOrder.solution || "暂无"

}

</p>



</div>









<div className="card report-card">


<h2>

📦 本次使用配件

</h2>



{


repairOrder.parts && repairOrder.parts.length>0 ?



repairOrder.parts.map((item,index)=>(


<p key={index}>

{item.name}

×

{item.quantity}

</p>


))


:

<p>

暂无配件

</p>



}



</div>









<div className="card report-card">


<h2>

📷照片/视频

</h2>



<p>

{

repairOrder.files ?

`已上传 ${repairOrder.files.length} 个文件`

:

"暂无"

}

</p>


</div>









<div className="card report-card">


<h2>

🛡保内保外

</h2>



<p>

{

repairOrder.warranty || "未判断"

}

</p>



</div>








<button

className="primary-btn"

onClick={submitRepair}

>

确认提交维修

</button>







</div>


)


}



export default RepairFinish