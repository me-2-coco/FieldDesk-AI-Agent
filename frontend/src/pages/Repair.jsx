import { useState, useCallback } from "react"

import ScannerModal from "../components/ScannerModal.jsx"

import { identifyScanCode } from "../shared/scanHelper.js"



function Repair({setPage}) {


const [scannerOpen,setScannerOpen]=useState(false)


const [logisticsNo,setLogisticsNo]=useState("")


const [queryResult,setQueryResult]=useState(null)


const [signSN,setSignSN]=useState("")


const [message,setMessage]=useState("")


const [signed,setSigned]=useState(false)



// 模拟CRM数据

const mockOrder={


crmNo:"CRM-20260716001",

logisticsNo:"SF202607160001",

customer:"王先生",

phone:"13688886666",

address:"浙江省杭州市",

product:"扫地机器人 X2",

model:"X2",

fault:"机器运行时异响",

warranty:"待确认"

}





// 查询

function queryOrder(){


if(!logisticsNo.trim()){

setMessage("请输入物流单号")

return

}


setMessage("")


setQueryResult(mockOrder)


}




// 扫码

const handleScan=useCallback(

(value)=>{


const result=identifyScanCode(value)


const code=String(result.code || "")


setLogisticsNo(code)


setScannerOpen(false)


setQueryResult(mockOrder)



},

[])




// 判断设备类型

function getMachineType(sn){


if(sn.startsWith("W")){

return "洗地机"

}


if(sn.startsWith("R")){

return "扫地机"

}


return ""

}




// 签收

function handleSign(){


if(!signSN.trim()){

setMessage(
"请输入机器SN后才能签收"
)

return

}



const repairData={

crmNo:mockOrder.crmNo,

logisticsNo:mockOrder.logisticsNo,

customer:mockOrder.customer,

phone:mockOrder.phone,

address:mockOrder.address,

product:mockOrder.product,

model:mockOrder.model,

sn:signSN.trim(),

originalFault:mockOrder.fault,

status:"待维修",

statusUpdatedAt:new Date().toLocaleString()

}



localStorage.setItem(

"currentRepair",

JSON.stringify(repairData)

)



setSigned(true)


setMessage(
"签收成功，可以开始维修"
)


}






return(


<div className="page repair-page">





<div className="card">


<h2>
签收
</h2>



<div className="repair-search-row">


<input

placeholder="输入物流单号"

value={logisticsNo}

onChange={
e=>setLogisticsNo(e.target.value)
}

/>



<button

className="scan-btn"

onClick={
()=>setScannerOpen(true)
}

>

扫码

</button>


</div>




<button

className="primary-btn"

onClick={queryOrder}

>

查询

</button>



<p>

{message}

</p>



</div>







{


queryResult &&


<div className="card">


<h2>
机器信息
</h2>




<p>
CRM工单：
{queryResult.crmNo}
</p>



<p>
物流单号：
{queryResult.logisticsNo}
</p>



<p>
客户：
{queryResult.customer}
</p>



<p>
电话：
{queryResult.phone}
</p>



<p>
产品：
{queryResult.product}
</p>



<p>
型号：
{queryResult.model}
</p>




<p>

故障：
{queryResult.fault}

</p>





<hr/>





{

!signed ?



<>


<h3>
SN（必填）
</h3>


<input

placeholder="请输入机器SN"

value={signSN}

onChange={
e=>setSignSN(e.target.value)
}

/>



<p>

签收备注：

{getMachineType(signSN)}

</p>




<button

className="primary-btn"

onClick={handleSign}

>

确认签收

</button>


</>



:



<>


<h3>

✅ 已签收

</h3>



<p>

CRM状态：

检测中

</p>



<button

className="primary-btn"

onClick={()=>setPage("repairWork")}

>

开始维修

</button>


</>


}



</div>


}







<ScannerModal

open={scannerOpen}

title="扫描物流单号"

onScan={handleScan}

onClose={
()=>setScannerOpen(false)
}

/>





</div>


)


}



export default Repair