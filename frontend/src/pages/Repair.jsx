import { useState } from "react";
import ScannerModal from "../components/ScannerModal";
import {
  queryCrmOrderByLogisticsNo
} from "../shared/crmService.js"


function Repair({ setPage }) {


  const [orderNo, setOrderNo] = useState("");
  const [showScanner, setShowScanner] = useState(false);
  const [isLoading, setIsLoading] = useState(false);



  const searchRepair = async () => {

  if (!orderNo) {

    alert("请输入物流单号")

    return

  }


  try {
    setIsLoading(true)

    const result =
      await queryCrmOrderByLogisticsNo(orderNo)


    console.log(
      "CRM查询结果:",
      result
    )


    setPage("repairProcess")


  } catch(error) {

    alert(error.message)

  } finally {
    setIsLoading(false)
  }

}



  return (

    <div className="page">


      {/* 顶部标题 + 左上角返回箭头 */}

      <div className="page-top-header">


        <button

          className="arrow-back"

          onClick={() => setPage("home")}

        >

          ←

        </button>



        <h1>
          查询
        </h1>


      </div>




      <div className="card">


        <h2>
          查询寄修机器
        </h2>



        <p>
          输入物流单号查询CRM寄修记录
        </p>



        <div className="scan-input-row">

  <input
  value={orderNo}
  onChange={(e)=>setOrderNo(e.target.value)}
  onKeyDown={(e) => {
    if (e.key === "Enter" && !isLoading) searchRepair()
  }}
  placeholder="请输入物流单号"
  disabled={isLoading}
/>

  <button
  className="scan-btn"
  onClick={() => {
    console.log("点击扫码");
    setShowScanner(true);
  }}
>
  📷
</button>

</div>



        <button

          onClick={searchRepair}
          disabled={isLoading}

        >

          {isLoading ? "正在安全联调..." : "查询并填写签收信息"}

        </button>



      </div>
        {showScanner && (
  <ScannerModal
    open={showScanner}
    onScan={(code)=>{
      setOrderNo(code);
      setShowScanner(false);
    }}
    onClose={()=>{
      setShowScanner(false);
    }}
  />
)}



    </div>

  );

}


export default Repair;
