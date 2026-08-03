import { useState } from "react"
import { saveInspection } from "../shared/crmService.js"
import {
  getCurrentRepairOrder,
  REPAIR_STATUS,
  updateRepairOrder
} from "../shared/repairOrderStore.js"


function RepairProcess({ setPage }) {

  const [repairOrder, setRepairOrder] = useState(() =>
    getCurrentRepairOrder()
  )
  const [inspectionResult, setInspectionResult] = useState(
    repairOrder.inspectionResult || ""
  )
  const [inspectionRemark, setInspectionRemark] = useState(
    repairOrder.inspectionRemark || ""
  )
  const [message, setMessage] = useState("")
  const [errorMessage, setErrorMessage] = useState("")
  const [isSaving, setIsSaving] = useState(false)


  async function saveDetection() {
    if (!inspectionResult.trim()) {
      setErrorMessage("请输入检测结果")
      return
    }

    try {
      setIsSaving(true)
      setErrorMessage("")
      const result = await saveInspection({
        rmaNo: repairOrder.crmOrderNo,
        inspectionResult: inspectionResult.trim(),
        inspectionRemark: inspectionRemark.trim()
      })
      const updated = updateRepairOrder({
        inspectionResult: result.inspectionResult,
        inspectionRemark: result.inspectionRemark,
        status: REPAIR_STATUS.INSPECTION_COMPLETE
      })
      setRepairOrder(updated)
      setMessage(result.message || "检测信息已保存到 FieldDesk")
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setIsSaving(false)
    }
  }


  return (
    <div className="page repair-process-page">

      <div className="top-bar">
        <button className="arrow-back" onClick={() => setPage("repair")}>
          ←
        </button>
        <h1>检测登记</h1>
      </div>

      <div className="card machine-info-card">
        <div className="machine-card-header">
          <h2>工单信息</h2>
          <span className="repair-status-badge status-working">
            {repairOrder.status === REPAIR_STATUS.INSPECTION_COMPLETE
              ? REPAIR_STATUS.INSPECTION_COMPLETE
              : "已签收/待检测"}
          </span>
        </div>

        <p>工单号：{repairOrder.crmOrderNo || "-"}</p>
        <p>物流单号：{repairOrder.logisticsNo || "-"}</p>
        <p>SN：{repairOrder.sn || "-"}</p>
        <p>产品线：{repairOrder.product || "-"}</p>
        <p>报修描述：{repairOrder.originalFault || "未提供"}</p>
        <p>维修师傅：{repairOrder.technician || "本地测试用户"}</p>
        <p>签收备注：{repairOrder.receiptRemark || "-"}</p>
      </div>

      <div className="card">
        <h2>检测记录</h2>

        <label htmlFor="inspection-result">检测结果</label>
        <textarea
          id="inspection-result"
          value={inspectionResult}
          onChange={(event) => setInspectionResult(event.target.value)}
          placeholder="请输入检测结果"
          rows="4"
        />

        <label htmlFor="inspection-remark">检测备注</label>
        <textarea
          id="inspection-remark"
          value={inspectionRemark}
          onChange={(event) => setInspectionRemark(event.target.value)}
          placeholder="请输入检测备注（选填）"
          rows="3"
        />

        {errorMessage && <p className="error-message">{errorMessage}</p>}
        {message && <p role="status">{message}</p>}

        <button
          className="primary-btn"
          onClick={saveDetection}
          disabled={isSaving}
        >
          {isSaving ? "正在保存..." : "保存检测信息"}
        </button>

        <p className="dry-run-notice">
          当前仅保存到 FieldDesk，本阶段不会操作瑞云
        </p>

        {repairOrder.status === REPAIR_STATUS.INSPECTION_COMPLETE && (
          <>
            <button className="primary-btn" onClick={() => setPage("partsApplication")}>
              申请配件
            </button>
            <button className="secondary-btn" onClick={() => setPage("repairCompletion")}>
              进入维修完工
            </button>
          </>
        )}
      </div>

    </div>
  )
}

export default RepairProcess
