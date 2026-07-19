import { useState } from "react";


function RepairWork({ setPage }) {


  const [repairOrder, setRepairOrder] = useState(() => {

    const data = localStorage.getItem("currentRepair");

    return data ? JSON.parse(data) : {};

  });



  const [keyword, setKeyword] = useState("");

  const [quantity, setQuantity] = useState(1);

  const [warranty, setWarranty] = useState(
    repairOrder.warranty || ""
  );


  const [message, setMessage] = useState("");



  // 模拟库存数据
  const partsDatabase = [

    {
      code: "00100123",
      name: "主刷电机",
      stock: 50
    },

    {
      code: "00100234",
      name: "电池组件",
      stock: 20
    },

    {
      code: "00100345",
      name: "滚刷",
      stock: 100
    }

  ];



  const matchedPart = partsDatabase.find(item =>

    item.code.includes(keyword) ||
    item.name.includes(keyword)

  );





  function applyPart(){


    if(!matchedPart){

      setMessage("请选择有效配件");

      return;

    }



    const part={


      code: matchedPart.code,


      name: matchedPart.name,


      quantity:Number(quantity),


      stock:matchedPart.stock,


      phone:repairOrder.phone,


      sn:repairOrder.sn,


      status:"申请中"


    };





    const update={


      ...repairOrder,


      parts:[

        ...(repairOrder.parts || []),

        part

      ],


      warranty:warranty


    };





    localStorage.setItem(

      "currentRepair",

      JSON.stringify(update)

    );



    setRepairOrder(update);


    setKeyword("");

    setQuantity(1);


    setMessage("配件申请成功");


  }







  function goFinish(){


    const update={

      ...repairOrder,

      warranty:warranty

    };



    localStorage.setItem(

      "currentRepair",

      JSON.stringify(update)

    );



    setPage("repairFinish");


  }









  return(


<div className="page repair-work-page">





<div className="top-bar">


<button

className="arrow-back"

onClick={()=>setPage("repair")}

>

←

</button>


<h1>
检测
</h1>


</div>









<div className="card machine-info-card">


<div className="machine-card-header">


<h2>
📦机器信息
</h2>


<span className="repair-status-badge status-working">
检测中
</span>


</div>





<div className="machine-info-list">


<p>

客户：

{repairOrder.customer || "王先生"}

</p>


<p>

电话：

{repairOrder.phone || "13688886666"}

</p>



<p>

产品：

{repairOrder.product || "扫地机器人X2"}

</p>



<p>

SN：

{repairOrder.sn || "-"}

</p>



<p>

用户故障描述：

{repairOrder.fault || "机器运行时异响"}

</p>


</div>


</div>

















<div className="card">


<h2>
📦 配件申请
</h2>





<label className="part-title">
物料搜索
</label>


<input

className="part-search-input"

placeholder="请输入物料编码"

value={keyword}

onChange={(e)=>setKeyword(e.target.value)}

 />






{
matchedPart && (


<div className="part-search-result">


<p>
物料编码：
<strong>
{matchedPart.code}
</strong>
</p>


<p>
配件名称：
<strong>
{matchedPart.name}
</strong>
</p>


<p>
总库库存：
<strong>
{matchedPart.stock}
</strong>
</p>


</div>


)

}







<label>

申请数量

</label>


<input


type="number"

min="1"

value={quantity}


onChange={(e)=>setQuantity(e.target.value)}


/>






<button

className="primary-btn"

onClick={applyPart}

>

申请配件

</button>



<p>
{message}
</p>


</div>









<div className="card">


<h2>
本次申请配件
</h2>





{

repairOrder.parts && repairOrder.parts.length>0 ?


repairOrder.parts.map((item,index)=>(


<div key={index}>


<p>

物料编码：
{item.code}

</p>


<p>

名称：
{item.name}

×

{item.quantity}

</p>


</div>


))


:


<p>
暂无申请
</p>


}



</div>








<button

className="primary-btn"

onClick={()=>setPage("repairProcess")}

>

进入维修

</button>







</div>


  );


}


export default RepairWork;