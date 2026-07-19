import React, { useState } from "react";
import ScannerModal from "../components/ScannerModal";


function Repair({ setPage }) {


  const [orderNo, setOrderNo] = useState("");
  const [showScanner, setShowScanner] = useState(false);



  const searchRepair = () => {

    if (!orderNo) {

      alert("请输入物流单号");

      return;

    }


    // 后续这里接 CRM 查询
    // 查询成功进入维修流程

    setPage("repairWork");

  };



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
  placeholder="请输入物流单号"
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

        >

          查询

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