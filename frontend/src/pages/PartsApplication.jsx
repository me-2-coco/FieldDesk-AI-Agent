import { useMemo, useState } from "react"
import { applyLocalPart } from "../shared/crmService.js"
import {
  getCurrentRepairOrder,
  REPAIR_STATUS,
  updateRepairOrder
} from "../shared/repairOrderStore.js"


const LOCAL_PARTS = [
  { code: "00100123", name: "主刷电机", stock: 50 },
  { code: "00100234", name: "电池组件", stock: 20 },
  { code: "00100345", name: "滚刷", stock: 0 }
]


function PartsApplication({ setPage }) {
  const [repairOrder, setRepairOrder] = useState(() =>
    getCurrentRepairOrder()
  )
  const [keyword, setKeyword] = useState("")
  const [selectedCode, setSelectedCode] = useState("")
  const [quantity, setQuantity] = useState(1)
  const [message, setMessage] = useState("")
  const [errorMessage, setErrorMessage] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  const matches = useMemo(() => {
    const value = keyword.trim()
    if (!value) return LOCAL_PARTS
    return LOCAL_PARTS.filter((part) =>
      part.code.includes(value) || part.name.includes(value)
    )
  }, [keyword])

  const selectedPart = LOCAL_PARTS.find(
    (part) => part.code === selectedCode
  )

  async function submitApplication() {
    if (!selectedPart) {
      setErrorMessage("请选择配件")
      return
    }
    if (selectedPart.stock === 0) {
      setErrorMessage("库存为 0，无法申请")
      return
    }

    try {
      setIsSaving(true)
      setErrorMessage("")
      const result = await applyLocalPart({
        rmaNo: repairOrder.crmOrderNo,
        partCode: selectedPart.code,
        quantity: Number(quantity)
      })
      const application = result.application
      const updated = updateRepairOrder({
        status: REPAIR_STATUS.WAIT_PARTS,
        parts: [
          ...(repairOrder.parts || []),
          {
            id: application.id,
            code: application.partCode,
            name: application.partName,
            quantity: application.quantity,
            sn: application.sn,
            status: "已记录"
          }
        ]
      })
      setRepairOrder(updated)
      setMessage(result.message || "配件申请已保存到 FieldDesk")
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="page">
      <div className="top-bar">
        <button className="arrow-back" onClick={() => setPage("repairProcess")}>
          ←
        </button>
        <h1>申请配件</h1>
      </div>

      <div className="card">
        <p>寄修单号：{repairOrder.crmOrderNo || "-"}</p>
        <p>SN：{repairOrder.sn || "-"}</p>
        <p>产品线：{repairOrder.product || "-"}</p>
      </div>

      <div className="card">
        <label htmlFor="part-search">搜索配件</label>
        <input
          id="part-search"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="输入配件编码或名称"
        />

        <div className="part-search-result">
          {matches.map((part) => (
            <label key={part.code}>
              <input
                type="radio"
                name="part"
                value={part.code}
                checked={selectedCode === part.code}
                onChange={() => setSelectedCode(part.code)}
              />
              {part.name}（{part.code}）— 总库库存：{part.stock}
            </label>
          ))}
        </div>

        <label htmlFor="part-quantity">申请数量</label>
        <input
          id="part-quantity"
          type="number"
          min="1"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
        />

        {errorMessage && <p className="error-message">{errorMessage}</p>}
        {message && <p role="status">{message}</p>}

        <button
          className="primary-btn"
          onClick={submitApplication}
          disabled={isSaving || selectedPart?.stock === 0}
        >
          {isSaving ? "正在保存..." : "保存配件申请"}
        </button>

        <p className="dry-run-notice">
          当前仅保存到 FieldDesk，不连接瑞云，也不进入审批流程
        </p>
        {message && (
          <div className="workflow-actions">
            <button className="primary-btn" onClick={() => setPage("inventory")}>进入个人库存使用配件</button>
            <button className="secondary-btn" onClick={() => setPage("repairCompletion")}>不需使用配件，进入维修完工</button>
          </div>
        )}
      </div>
    </div>
  )
}

export default PartsApplication
