import { useEffect, useMemo, useState } from "react"
import SupervisionNoticeCard from "../components/SupervisionNoticeCard.jsx"
import { applyLocalPart, getRepairParts, searchPartsCatalog, updateRepairPart } from "../shared/crmService.js"
import {
  getCurrentRepairOrder,
  REPAIR_STATUS,
  updateRepairOrder
} from "../shared/repairOrderStore.js"


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
  const [parts, setParts] = useState([])
  const [isSearching, setIsSearching] = useState(false)
  const [selectedParts, setSelectedParts] = useState([])

  useEffect(() => {
    let active = true
    getRepairParts(repairOrder.crmOrderNo)
      .then((result) => active && setSelectedParts(result.items || []))
      .catch((error) => active && setErrorMessage(error.message))
    return () => { active = false }
  }, [repairOrder.crmOrderNo])

  useEffect(() => {
    let active = true
    const timer = setTimeout(async () => {
      try {
        setIsSearching(true)
        const result = await searchPartsCatalog({ rmaNo: repairOrder.crmOrderNo, keyword })
        if (active) {
          setParts(result.items || [])
          setErrorMessage("")
        }
      } catch (error) {
        if (active) setErrorMessage(error.message)
      } finally {
        if (active) setIsSearching(false)
      }
    }, 180)
    return () => { active = false; clearTimeout(timer) }
  }, [keyword, repairOrder.crmOrderNo])

  const matches = useMemo(() => parts, [parts])

  const selectedPart = parts.find(
    (part) => part.code === selectedCode
  )

  async function submitApplication() {
    if (!selectedPart) {
      setErrorMessage("请选择配件")
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
      setSelectedParts((current) => {
        const exists = current.some((item) => item.id === application.id)
        return exists ? current.map((item) => item.id === application.id ? application : item) : [...current, application]
      })
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
            retailPrice: application.retailPrice,
            repairLevel: application.repairLevel,
            returnRequired: application.returnRequired,
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

  async function changeApplication(application, nextQuantity, remove = false) {
    try {
      setIsSaving(true)
      setErrorMessage("")
      const result = await updateRepairPart({
        rmaNo: repairOrder.crmOrderNo,
        applicationId: application.id,
        quantity: Number(nextQuantity),
        remove
      })
      setSelectedParts(result.order?.partApplications || [])
      setMessage(result.message)
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="page">
      <div className="top-bar">
        <button className="arrow-back" onClick={() => setPage("repair")}>
          ←
        </button>
        <h1>申请配件</h1>
      </div>

      <SupervisionNoticeCard rmaNo={repairOrder.crmOrderNo} />

      <div className="card">
        <p>寄修单号：{repairOrder.crmOrderNo || "-"}</p>
        <p>SN：{repairOrder.sn || "-"}</p>
        <p>产品线：{repairOrder.product || "-"}</p>
      </div>

      <div className="card">
        <h2>本工单已选配件</h2>
        {!selectedParts.length && <p>尚未选择配件</p>}
        {selectedParts.map((part) => (
          <div className="selected-part-row" key={part.id}>
            <div>
              <strong>{part.partName}</strong>
              <p>{part.partCode} · {part.repairLevel} · ¥{part.retailPrice}{part.returnRequired ? " · 旧件需返厂" : ""}</p>
            </div>
            <input
              aria-label={`${part.partName}数量`}
              type="number"
              min="1"
              defaultValue={part.quantity}
              onBlur={(event) => Number(event.target.value) !== part.quantity && changeApplication(part, event.target.value)}
              disabled={isSaving}
            />
            <button type="button" className="secondary-btn" onClick={() => changeApplication(part, part.quantity, true)} disabled={isSaving}>删除</button>
          </div>
        ))}
        {!!selectedParts.length && (
          <p>配件金额合计：¥{selectedParts.reduce((sum, part) => sum + Number(part.retailPrice || 0) * Number(part.quantity || 0), 0)}</p>
        )}
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
          {isSearching && <p>正在查询厂家飞书配件表...</p>}
          {!isSearching && matches.length === 0 && <p>当前机型下未找到匹配配件</p>}
          {matches.map((part) => (
            <label key={part.code}>
              <input
                type="radio"
                name="part"
                value={part.code}
                checked={selectedCode === part.code}
                onChange={() => setSelectedCode(part.code)}
              />
              {part.name}（{part.code}）— {part.repairLevel} / 零售价 ¥{part.retailPrice}
              {part.returnRequired ? " / 旧件需返厂" : ""}
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
          disabled={isSaving || !selectedPart}
        >
          {isSaving ? "正在保存..." : "保存配件申请"}
        </button>

        <p className="dry-run-notice">
          配件与价格实时查询厂家飞书表；当前只记录到 FieldDesk，不写入瑞云
        </p>
        {message && (
          <div className="workflow-actions">
            <button className="primary-btn" onClick={() => setPage("inventory")}>进入个人库存使用配件</button>
            <button className="secondary-btn" onClick={() => setPage("repairWork")}>配件准备完成，进入维修</button>
          </div>
        )}
      </div>
    </div>
  )
}

export default PartsApplication
