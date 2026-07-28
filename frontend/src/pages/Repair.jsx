import { useState } from "react"
import ScannerModal from "../components/ScannerModal"
import {
  queryCrmOrderByLogisticsNo
} from "../shared/crmService.js"


function Repair({ setPage }) {

  const [orderNo, setOrderNo] = useState("")
  const [showScanner, setShowScanner] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [repairDetail, setRepairDetail] = useState(null)
  const [errorMessage, setErrorMessage] = useState("")


  async function searchRepair() {

    if (!orderNo.trim()) {
      setErrorMessage("请输入物流单号")
      return
    }

    try {
      setIsLoading(true)
      setErrorMessage("")
      setRepairDetail(null)

      const result = await queryCrmOrderByLogisticsNo(orderNo)
      setRepairDetail(result)

    } catch (error) {
      setErrorMessage(error.message)

    } finally {
      setIsLoading(false)
    }

  }


  function resetResult() {
    setErrorMessage("")
    setRepairDetail(null)
  }


  return (

    <div className="page">

      <div className="page-top-header">

        <button
          className="arrow-back"
          onClick={() => setPage("home")}
        >
          ←
        </button>

        <h1>到店查询</h1>

      </div>


      <div className="card">

        <h2>查询寄修机器</h2>

        <p>
          扫描物流单号，只读查询瑞云 RMA 寄修单
        </p>

        <div className="scan-input-row">

          <input
            value={orderNo}
            onChange={(event) => {
              setOrderNo(event.target.value)
              resetResult()
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !isLoading) {
                searchRepair()
              }
            }}
            placeholder="请输入物流单号"
            disabled={isLoading}
          />

          <button
            className="scan-btn"
            aria-label="扫描物流单号"
            onClick={() => setShowScanner(true)}
          >
            📷
          </button>

        </div>

        <button
          onClick={searchRepair}
          disabled={isLoading}
        >
          {isLoading ? "正在只读查询..." : "查询 RMA 寄修单"}
        </button>

        <p className="read-only-tip">
          只读模式：不会签收、不会填写 SN、不会修改瑞云数据
        </p>

      </div>


      {errorMessage && (

        <div className="card message-card" role="alert">

          <h2>查询失败</h2>

          <p className="error-text">
            {errorMessage}
          </p>

        </div>

      )}


      {repairDetail && (

        <div className="card rma-detail-card">

          <div className="rma-detail-heading">

            <h2>RMA 寄修单资料</h2>

            <span className="read-only-badge">
              只读
            </span>

          </div>

          <dl className="rma-detail-list">

            <div>
              <dt>寄修单号</dt>
              <dd>{repairDetail.rmaNo}</dd>
            </div>

            <div>
              <dt>用户姓名</dt>
              <dd>{repairDetail.customer?.name}</dd>
            </div>

            <div>
              <dt>脱敏手机号</dt>
              <dd>{repairDetail.customer?.phoneMasked}</dd>
            </div>

            <div>
              <dt>所在地区/地址</dt>
              <dd>{repairDetail.customer?.regionAddress}</dd>
            </div>

            <div>
              <dt>用户报修描述</dt>
              <dd>{repairDetail.reportedFault}</dd>
            </div>

            <div>
              <dt>取件物流单号</dt>
              <dd>{repairDetail.pickupLogisticsNo}</dd>
            </div>

          </dl>

          <button disabled>
            下一步：录入 SN（待签收模块完成）
          </button>

        </div>

      )}


      {showScanner && (

        <ScannerModal
          open={showScanner}
          onScan={(code) => {
            setOrderNo(code)
            setShowScanner(false)
            resetResult()
          }}
          onClose={() => setShowScanner(false)}
        />

      )}

    </div>

  )

}


export default Repair
