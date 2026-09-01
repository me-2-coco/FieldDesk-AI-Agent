import { useEffect, useMemo, useState } from "react"
import SupervisionNoticeCard from "../components/SupervisionNoticeCard.jsx"
import { applyLocalPart, confirmRepairParts, getRepairParts, searchPartsCatalog, updateRepairPart } from "../shared/crmService.js"
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
  const [pricing, setPricing] = useState(null)

  useEffect(() => {
    let active = true
    getRepairParts(repairOrder.crmOrderNo)
      .then((result) => {
        if (!active) return
        setSelectedParts(result.items || [])
        setPricing(result.pricing || null)
      })
      .catch((error) => active && setErrorMessage(error.message))
    return () => { active = false }
  }, [repairOrder.crmOrderNo])

  useEffect(() => {
    let active = true
    if (!keyword.trim()) {
      return () => { active = false }
    }
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
  const selectedPartsHaveKnownPrice = selectedParts.every((part) =>
    part.retailPrice !== null && part.retailPrice !== undefined && part.retailPrice !== "" &&
    Number.isFinite(Number(part.retailPrice)) && Number(part.retailPrice) >= 0
  )
  const selectedPartsTotal = selectedPartsHaveKnownPrice
    ? selectedParts.reduce((sum, part) => sum + Number(part.retailPrice) * Number(part.quantity || 0), 0)
    : null
  const priceText = (value) => Number.isFinite(Number(value)) && value !== null && value !== ""
    ? `¥${Number(value).toFixed(2)}`
    : "暂无价格"

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
      setPricing(result.pricing || null)
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
      setPricing(result.pricing || null)
      setMessage(result.message)
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setIsSaving(false)
    }
  }

  async function continueToCompletion() {
    if (!selectedParts.length) return
    try {
      setIsSaving(true)
      setErrorMessage("")
      const result = await confirmRepairParts(repairOrder.crmOrderNo)
      const updated = updateRepairOrder({
        status: result.nextStep === "repairCompletion" ? REPAIR_STATUS.REPAIRING : REPAIR_STATUS.WAIT_INSPECTION
      })
      setRepairOrder(updated)
      setPage(result.nextStep === "repairCompletion" ? "repairCompletion" : "repairProcess")
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="page parts-application-page">
      <div className="top-bar">
        <button className="arrow-back" onClick={() => setPage("repairDecision")}>
          ←
        </button>
        <h1>申请配件</h1>
      </div>

      <SupervisionNoticeCard rmaNo={repairOrder.crmOrderNo} />

      <section className="card parts-order-card">
        <div className="parts-order-hero"><span>机器 SN</span><strong>{repairOrder.sn || "-"}</strong><small>{repairOrder.product || "待确认品类"}</small></div>
        <dl className="parts-order-grid">
          <div><dt>寄修单号</dt><dd>{repairOrder.crmOrderNo || "-"}</dd></div>
          <div><dt>物流单号</dt><dd>{repairOrder.logisticsNo || "送修（无物流单号）"}</dd></div>
          <div><dt>用户姓名</dt><dd>{repairOrder.customer || "未提供"}</dd></div>
          <div><dt>维修品类</dt><dd>{repairOrder.specialty || repairOrder.product || "未提供"}</dd></div>
        </dl>
        <div className="parts-order-fault"><span>报修描述</span><p>{repairOrder.originalFault || "未提供"}</p></div>
      </section>

      <section className="card selected-parts-card">
        <h2>本工单已选配件</h2>
        {!selectedParts.length && <p>尚未选择配件</p>}
        {selectedParts.map((part) => (
          <div className="selected-part-row" key={part.id}>
            <div>
              <strong>{part.partName}</strong>
              <p>{part.partCode} · {part.repairLevel} · {priceText(part.retailPrice)}{part.returnRequired && <strong className="part-return-required">旧件需返厂</strong>}</p>
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
          <p>配件金额合计：{selectedPartsTotal === null ? "待核价（存在未配置零售价）" : `¥${selectedPartsTotal.toFixed(2)}`}</p>
        )}
        {pricing?.warrantyStatus === "保外" && (
          <div className="pricing-preview" role="status">
            <p>维修等级：{pricing.highestLevel || "等待配件维修等级"}</p>
            <p>维修费：¥{pricing.repairFee || 0}</p>
            <p>配件费：¥{pricing.partsFee || 0}</p>
            <strong>当前已知费用：¥{pricing.knownTotal || 0}</strong>
          </div>
        )}
      </section>

      <section className="card parts-search-card">
        <h2>搜索配件</h2>
        <input
          id="part-search"
          value={keyword}
          onChange={(event) => {
            const value = event.target.value
            setKeyword(value)
            if (!value.trim()) {
              setParts([])
              setIsSearching(false)
              setSelectedCode("")
            }
          }}
          placeholder="输入配件编码或名称"
        />

        <div className="part-search-result">
          {isSearching && <p>正在查询厂家飞书配件表...</p>}
          {!isSearching && keyword.trim() && matches.length === 0 && <p>当前机型下未找到匹配配件</p>}
          {matches.map((part) => (
            <label className="part-search-item" key={part.code}>
              <input
                type="radio"
                name="part"
                value={part.code}
                checked={selectedCode === part.code}
                onChange={() => setSelectedCode(part.code)}
              />
              <span className="part-search-copy">
                <span>{part.name}（{part.code}）— {part.repairLevel} / 零售价 {priceText(part.retailPrice)}</span>
                {part.returnRequired && <strong className="part-return-required">旧件需返厂</strong>}
              </span>
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
        <button className="primary-btn" onClick={continueToCompletion} disabled={isSaving || selectedParts.length === 0}>
          {selectedParts.length ? "配件确认完成，进入维修完工" : "请先添加维修配件"}
        </button>
      </section>
    </div>
  )
}

export default PartsApplication
