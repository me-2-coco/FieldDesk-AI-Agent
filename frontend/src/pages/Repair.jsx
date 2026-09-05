import { useEffect, useState } from "react"
import ScannerModal from "../components/ScannerModal"
import PhotoCaptureModal from "../components/PhotoCaptureModal"
import { CameraIcon, ScanIcon } from "../components/AppIcons.jsx"
import AttachmentPreviewList from "../components/AttachmentPreviewList.jsx"
import {
  completeLocalReceipt,
  downloadRepairAttachment,
  getCurrentFieldDeskUser,
  getLocalRepairOrders,
  getRepeatRepairBySn,
  getSystemHealth,
  prepareReceipt,
  queryCrmRepairByAnyIdentifier,
  uploadReceiptAttachment
} from "../shared/crmService.js"
import {
  createRepairOrder,
  REPAIR_STATUS,
  saveCurrentRepairOrder
} from "../shared/repairOrderStore.js"
import { resumePageForLocalWorkflow } from "../shared/repairNavigation.js"
import {
  getReceiptSpecialtyGate,
  normalizeReceiptSn,
  REPAIR_SPECIALTIES,
  validateReceiptSn
} from "../shared/receiptPreparation.js"

function displayRepairTime(value) {
  if (!value) return "时间未记录"
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? value : time.toLocaleDateString("zh-CN")
}

function MachineRepairHistory({ history }) {
  if (!history?.records?.length) return null
  return <section className={`machine-history-panel ${history.isRepeatRepair ? "is-repeat" : ""}`}>
    <div className="machine-history-heading">
      <div>
        {history.isRepeatRepair && <strong>重复维修</strong>}
        <span>{history.isRepeatRepair ? "同一电话且同一 SN 一个月内再次送修" : "该机器存在历史维修记录"}</span>
      </div>
      <b>{history.records.length} 次</b>
    </div>
    {history.previousTechnicianName && <p className="previous-technician">上次维修师傅：<strong>{history.previousTechnicianName}</strong></p>}
    <div className="machine-history-list">
      {history.records.map((record) => <article key={`${record.rmaNo}-${record.completedAt}`}>
        <div><strong>{record.rmaNo || "寄修单号未记录"}</strong><span>{displayRepairTime(record.completedAt)}</span></div>
        <p>维修师傅：{record.technicianName || "未记录"}</p>
        <p>故障描述：{record.reportedFault || "未记录"}</p>
      </article>)}
    </div>
  </section>
}


function Repair({ setPage, currentUser: signedInUser = null }) {

  const [orderNo, setOrderNo] = useState("")
  const [scannerMode, setScannerMode] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [repairDetail, setRepairDetail] = useState(null)
  const [searchMatches, setSearchMatches] = useState([])
  const [errorMessage, setErrorMessage] = useState("")
  const [receiptStep, setReceiptStep] = useState("detail")
  const [sn, setSn] = useState("")
  const [specialty, setSpecialty] = useState("")
  const [receiptMessage, setReceiptMessage] = useState("")
  const [isSaving, setIsSaving] = useState(false)
  const [currentUser, setCurrentUser] = useState(signedInUser)
  const [authError, setAuthError] = useState("")
  const [receiptAttachments, setReceiptAttachments] = useState([])
  const [photoCameraOpen, setPhotoCameraOpen] = useState(false)
  const [machineHistory, setMachineHistory] = useState(null)
  const [receiptWriteEnabled, setReceiptWriteEnabled] = useState(false)
  const specialtyGate = getReceiptSpecialtyGate(
    currentUser,
    repairDetail?.productLine
  )
  const queriedLogisticsNo = repairDetail?.logisticsNo || repairDetail?.pickupLogisticsNo || ""

  function frontendStatusForLocalOrder(order, targetPage) {
    if (order.status === "COMPLETED") return REPAIR_STATUS.COMPLETED
    if (order.status === "SHIPPED_PENDING_COMPLETION") return REPAIR_STATUS.SHIPPED_PENDING_COMPLETION
    if (order.status === "REPAIR_COMPLETED_PENDING_SHIPMENT") return REPAIR_STATUS.REPAIR_COMPLETED_PENDING_SHIPMENT
    if (targetPage === "repairCompletion") return REPAIR_STATUS.REPAIRING
    if (order.status === "INSPECTION_COMPLETED_PENDING_REPAIR") return REPAIR_STATUS.INSPECTION_COMPLETE
    return REPAIR_STATUS.WAIT_INSPECTION
  }

  function restoreLocalOrder(order, targetPage, queryResult) {
    const restoredParts = order.repairCompletion?.usedParts?.length
      ? order.repairCompletion.usedParts
      : Array.isArray(order.partApplications)
        ? order.partApplications
        : []
    saveCurrentRepairOrder({
      id: `RMA-${order.rmaNo}`,
      crmOrderNo: order.rmaNo,
      logisticsNo: order.logisticsNo || queryResult.logisticsNo || queryResult.pickupLogisticsNo || "",
      customer: order.customerName || queryResult.customer?.name || "",
      phone: order.phoneMasked || queryResult.customer?.phoneMasked || "",
      address: order.regionAddress || queryResult.customer?.regionAddress || "",
      product: order.productLine || order.specialty || queryResult.productLine || "",
      model: order.productLine || order.specialty || queryResult.productLine || "",
      sn: order.sn || "",
      projectCode: order.recloudProjectCode || order.projectCode || "",
      warrantyType: order.technicianWarranty || order.warrantyType || "",
      originalFault: order.reportedFault || queryResult.reportedFault || "",
      inspectionResult: order.inspectionResult || "",
      inspectionRemark: order.inspectionRemark || "",
      crmFault: order.faultCategory || "",
      level3Fault: order.faultCategory || "",
      treatmentMode: order.treatmentMode || "",
      treatmentLabel: order.treatmentLabel || "",
      resumeStep: targetPage,
      specialty: order.specialty || order.productLine || "",
      receiptRemark: order.remark || "",
      technician: order.technicianName || order.operatorName || "",
      usedParts: restoredParts,
      parts: restoredParts,
      attachments: order.repairCompletion?.attachments || [],
      status: frontendStatusForLocalOrder(order, targetPage),
      createdAt: order.createdAt || "",
      completedAt: order.completedAt || ""
    })
  }

  async function resumeExistingWorkflow(result, queryValue) {
    try {
      const localOrders = await getLocalRepairOrders(result.rmaNo || queryValue)
      const localOrder = localOrders.find((item) =>
        String(item.rmaNo || "").trim() === String(result.rmaNo || "").trim()
      )
      if (!localOrder?.sn) return false
      // 旧版本曾可能把联系电话或物流号误存为 SN。此类脏记录不能阻断重新录入。
      if (validateReceiptSn(localOrder.sn, localOrder.logisticsNo || result.pickupLogisticsNo || "")) {
        return false
      }
      if (localOrder.status === "RECEIPT_PREPARED") {
        setRepairDetail({ ...result, localWorkflow: localOrder })
        setSn(localOrder.sn)
        setSpecialty(localOrder.specialty || localOrder.productLine || result.productLine || "")
        setReceiptAttachments((localOrder.receiptAttachments || []).map((attachment) => ({
          ...attachment,
          uploaded: true
        })))
        setReceiptStep(localOrder.recloudReceiptSyncStatus === "RESULT_UNKNOWN" ? "detail" : "form")
        setErrorMessage(localOrder.recloudReceiptSyncStatus === "RESULT_UNKNOWN"
          ? "瑞云签收结果未知，已禁止重复提交，请联系管理员核对"
          : "")
        setReceiptMessage(localOrder.recloudReceiptSyncStatus === "FAILED"
          ? "上次瑞云签收失败，资料已保留，可以重新提交"
          : "已恢复到签收确认步骤，SN 和已上传照片均已保留")
        return true
      }
      const targetPage = resumePageForLocalWorkflow(localOrder)
      if (!targetPage) {
        setRepairDetail({ ...result, localWorkflow: localOrder })
        setReceiptStep("detail")
        setErrorMessage("")
        setReceiptMessage(localOrder.status === "TRANSFER_TO_HEADQUARTERS_PENDING"
          ? "该工单已录入 SN，当前为转总部待处理，不能重复签收"
          : localOrder.status === "MODEL_AUTHORIZATION_REVIEW"
            ? "上次流程停在机型校验，请重新录入 SN"
            : `该工单已存在，当前状态：${localOrder.status}`)
        return true
      }
      restoreLocalOrder(localOrder, targetPage, result)
      setErrorMessage("")
      setReceiptMessage(`已恢复工单当前进度：${localOrder.status}`)
      setPage(targetPage)
      return true
    } catch {
      return false
    }
  }

  useEffect(() => {
    let active = true
    queueMicrotask(() => active && setCurrentUser(signedInUser))
    getCurrentFieldDeskUser()
      .then((user) => {
        if (!active) return
        setCurrentUser((existing) => existing?.repairSpecialties?.length ? existing : user)
        setAuthError("")
      })
      .catch((error) => {
        if (active && !signedInUser) setAuthError(error.message)
      })
    return () => { active = false }
  }, [signedInUser])

  useEffect(() => {
    getSystemHealth()
      .then((health) => setReceiptWriteEnabled(Boolean(health.receiptWriteEnabled)))
      .catch(() => setReceiptWriteEnabled(false))
  }, [])

  async function searchRepair(queryOverride = "") {
    const queryValue = typeof queryOverride === "string" && queryOverride ? queryOverride : orderNo

    if (!queryValue.trim()) {
      setErrorMessage("请输入物流单号、电话、SN或寄修单号")
      return
    }

    try {
      setIsLoading(true)
      setErrorMessage("")
      setRepairDetail(null)
      setSearchMatches([])
      setMachineHistory(null)
      setSn("")
      // 每次查询都是一张新工单，不能继续展示上一张工单的签收/转寄提示。
      setReceiptMessage("")
      setReceiptStep("detail")

      let result = await queryCrmRepairByAnyIdentifier(queryValue)
      if (!result || typeof result !== "object") {
        throw new Error("工单查询返回异常，请重新查询")
      }
      if (Array.isArray(result.matches)) {
        if (result.matches.length === 0) {
          setReceiptMessage("未找到匹配工单")
          return
        }
        if (result.matches.length > 1) {
          setSearchMatches(result.matches)
          setReceiptMessage(`找到${result.matches.length}条匹配工单，请选择对应机器`)
          return
        }
        const match = result.matches[0]
        const detail = await queryCrmRepairByAnyIdentifier(match.rmaNo)
        const resolved = Array.isArray(detail?.matches) ? detail.matches[0] || match : detail || match
        const queriedByPhone = /^1[3-9]\d{9}$/.test(queryValue.trim())
        result = {
          ...match,
          ...resolved,
          customer: {
            ...(match.customer || {}),
            ...(resolved?.customer || {}),
            phoneMasked: queriedByPhone
              ? queryValue.trim()
              : resolved?.customer?.phoneMasked || match.customer?.phoneMasked || resolved?.phoneMasked || match.phoneMasked || "",
          },
        }
      }
      if (await resumeExistingWorkflow(result, queryValue)) return
      const returnedSn = normalizeReceiptSn(result.productSerialNo || "")
      const localWorkflowSn = normalizeReceiptSn(result.localWorkflow?.sn || "")
      const returnedSnInvalid = returnedSn
        && Boolean(validateReceiptSn(returnedSn, result.pickupLogisticsNo || result.logisticsNo || ""))
      const localWorkflowInvalid = localWorkflowSn
        && Boolean(validateReceiptSn(localWorkflowSn, result.localWorkflow?.logisticsNo || result.pickupLogisticsNo || ""))
      if (returnedSnInvalid || localWorkflowInvalid) {
        result = {
          ...result,
          productSerialNo: returnedSnInvalid ? "" : result.productSerialNo,
          localWorkflow: localWorkflowInvalid ? null : result.localWorkflow,
          cached: false
        }
      }
      setRepairDetail(result)
      setMachineHistory({
        isRepeatRepair: Boolean(result.isRepeatRepair),
        previousTechnicianName: result.previousTechnicianName || "",
        previousCompletedAt: result.previousCompletedAt || "",
        records: Array.isArray(result.repairHistory) ? result.repairHistory : []
      })
      setReceiptStep("detail")
      setReceiptMessage(result.cached ? "已从 FieldDesk 本地记录秒查，无需等待瑞云" : "")

    } catch (error) {
      setErrorMessage(error.message)

    } finally {
      setIsLoading(false)
    }

  }


  function resetResult() {
    setErrorMessage("")
    setRepairDetail(null)
    setSearchMatches([])
    setMachineHistory(null)
    setSn("")
    setReceiptStep("detail")
    setReceiptMessage("")
  }

  function startReceiptPreparation() {
    if (authError) {
      setErrorMessage(authError)
      return
    }
    if (specialtyGate.error) {
      setErrorMessage(specialtyGate.error)
      return
    }
    // 瑞云返回的 SN 只用于只读资料展示，不能代替师傅在签收步骤实机核对。
    // 每次进入录入页都清空，必须由师傅手输、扫码枪或摄像头扫码录入。
    setSn("")
    setMachineHistory(null)
    setSpecialty(specialtyGate.specialty)
    setErrorMessage("")
    setReceiptMessage("")
    setReceiptAttachments([])
    setErrorMessage("")
    setReceiptStep("form")
  }

  async function checkMachineHistory(value) {
    const normalizedSn = normalizeReceiptSn(value)
    if (!/^[A-Z0-9-]{8,}$/i.test(normalizedSn)) {
      setMachineHistory(null)
      return
    }
    try {
      const result = await getRepeatRepairBySn(normalizedSn, repairDetail?.rmaNo || "")
      setMachineHistory(result)
    } catch {
      setMachineHistory(null)
    }
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(new Error("附件读取失败"))
      reader.readAsDataURL(file)
    })
  }

  async function saveReceiptFiles(files) {
    if (!files.length) return
    const accepted = files.map((file) => {
      if (!/^(image|video)\//.test(file.type)) throw new Error("仅支持签收照片和视频")
      return { id: crypto.randomUUID(), name: file.name, mimeType: file.type, file }
    })
    setErrorMessage("")
    setReceiptAttachments((current) => [...current, ...accepted])
  }

  async function uploadReceiptFiles(event) {
    const files = [...event.target.files]
    await saveReceiptFiles(files)
    event.target.value = ""
  }

  async function finishReceiptAndOpenParts() {
    const normalizedSn = normalizeReceiptSn(sn)
    const snError = validateReceiptSn(
      normalizedSn,
      queriedLogisticsNo
    )
    if (snError) {
      setErrorMessage(snError)
      return
    }
    if (!specialty) {
      setErrorMessage("请选择本单维修品类")
      return
    }
    if (receiptAttachments.length === 0) {
      setErrorMessage("请至少拍摄或选择一张签收照片/视频")
      return
    }
    if (
      ["扫地机", "洗地机"].includes(repairDetail.productLine) &&
      specialty !== repairDetail.productLine
    ) {
      setErrorMessage(
        `该工单属于${repairDetail.productLine}，请选择对应维修品类`
      )
      return
    }
    try {
      setIsSaving(true)
      setErrorMessage("")
      const preparation = await prepareReceipt({
        logisticsNo: queriedLogisticsNo,
        rmaNo: repairDetail.rmaNo,
        sn: normalizedSn,
        specialty,
        productLine: repairDetail.productLine || "",
        customerName: repairDetail.customer?.name || "",
        phoneMasked: repairDetail.customer?.phoneMasked || "",
        regionAddress: repairDetail.customer?.regionAddress || "",
        reportedFault: repairDetail.reportedFault
      })
      const canContinueLocalWorkflow = preparation.authorization?.repairability === "SUPPORTED"
      if (!canContinueLocalWorkflow) {
        setReceiptStep("detail")
        setReceiptMessage(preparation.authorization?.reason || preparation.message || "当前机型不能在网点继续签收")
        return
      }
      for (const attachment of receiptAttachments) {
        if (attachment.uploaded) continue
        await uploadReceiptAttachment({
          rmaNo: repairDetail.rmaNo,
          name: attachment.name,
          mimeType: attachment.mimeType,
          data: await fileToDataUrl(attachment.file)
        })
      }
      const result = await completeLocalReceipt(repairDetail.rmaNo)
      const order = createRepairOrder({
        id: `RMA-${result.rmaNo}`,
        crmOrderNo: result.rmaNo,
        logisticsNo: result.logisticsNo,
        customer: result.customerName,
        phone: result.phoneMasked || repairDetail.customer?.phoneMasked || "",
        address: result.regionAddress,
        product: result.productLine,
        model: result.productLine,
        sn: result.sn,
        originalFault: result.reportedFault,
        technician: result.operatorName,
        status: REPAIR_STATUS.WAIT_INSPECTION,
        specialty: result.specialty,
        receiptRemark: result.remark
      })
      saveCurrentRepairOrder(order)
      setSn(normalizedSn)
      setPage("repairWarranty")
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setIsSaving(false)
    }
  }


  return (

    <div className="page repair-query-page">

      <div className="page-top-header repair-query-header">
        <div>
          <span>工单工作台</span>
          <h1>到店查询</h1>
        </div>

      </div>


      <div className="repair-query-hero">
        <div className="repair-query-hero-icon">查</div>
        <div>
          <span>维修机器快速定位</span>
          <strong>输入任意一项，即可查询工单</strong>
        </div>
        <small>只读</small>
      </div>

      <div className="card repair-query-card">

        <div className="repair-query-card-heading">
          <div>
            <span>工单检索</span>
            <h2>查询维修机器</h2>
          </div>
          <small>支持扫码</small>
        </div>

        <div className="repair-query-types" aria-label="支持的查询方式">
          <span>物流单号</span>
          <span>联系电话</span>
          <span>机器 SN</span>
          <span>寄修单号</span>
        </div>

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
            placeholder="输入物流单号、电话、SN或寄修单号"
            disabled={isLoading}
          />

          <button
            className="scan-btn"
            aria-label="扫描物流单号"
            onClick={() => setScannerMode("logistics")}
          >
            <ScanIcon />
          </button>

        </div>

        <button
          className="repair-query-submit"
          onClick={searchRepair}
          disabled={isLoading}
        >
          {isLoading ? "正在只读查询..." : "查询维修工单"}
        </button>

        <div className="repair-query-safe-tip">
          <span>✓</span>
          <p><strong>安全查询模式</strong>不会签收、不会填写 SN，也不会修改瑞云数据</p>
        </div>

      </div>


      {errorMessage && (

        <div className="card message-card" role="alert">

          <h2>查询失败</h2>

          <p className="error-text">
            {errorMessage}
          </p>

        </div>

      )}

      {searchMatches.length > 0 && <div className="card rma-match-card">
        <div className="rma-match-heading">
          <div>
            <span>查询结果{searchMatches.some((item) => item.isRepeatRepair) && <b className="rma-repeat-label">重复维修</b>}</span>
            <h2>选择对应工单</h2>
          </div>
          <strong>{searchMatches.length} 个</strong>
        </div>
        <p className="rma-match-tip">同一联系方式关联了多个工单，请根据产品线、机型和物流信息选择。</p>
        <div className="rma-match-list">
          {searchMatches.map((item) => {
            const [productName = "机型待确认", orderStatus = "待处理"] = String(item.summary || "").split("｜")
            return <button type="button" className="rma-match-item" key={item.rmaNo} onClick={() => {
              setOrderNo(item.rmaNo)
              setSearchMatches([])
              setTimeout(() => searchRepair(item.rmaNo), 0)
            }}>
              <span className="rma-match-item-top">
                <span>
                  <small>寄修单号</small>
                  <strong>{item.rmaNo}</strong>
                </span>
                <em className="rma-match-product-line">{item.productLine || "产品线待确认"}</em>
                <b aria-hidden="true">›</b>
              </span>
              <span className="rma-match-product">{productName || "机型待确认"}</span>
              {item.isRepeatRepair && <span className="rma-repeat-badge">重复维修 · 上次师傅：{item.previousTechnicianName || "待分配"}</span>}
              <span className="rma-match-meta">
                <span><small>物流单号</small><strong>{item.logisticsNo || "送修"}</strong></span>
                <span><small>联系电话</small><strong>{item.phoneMasked || "未显示"}</strong></span>
              </span>
              <span className={`rma-match-status ${orderStatus.includes("签收") ? "is-signed" : "is-picked"}`}>
                {orderStatus || "待处理"}
              </span>
            </button>
          })}
        </div>
      </div>}


      {repairDetail && receiptStep === "detail" && (

        <div className="card rma-detail-card">

          <div className="rma-detail-heading">

            <h2>RMA 寄修单资料</h2>

            <span className="read-only-badge">
              只读
            </span>

          </div>

          <div className="mobile-record-hero">
            <span>寄修单号</span>
            <strong>{repairDetail.rmaNo}</strong>
            <small>{repairDetail.productLine || "待确认品类"}</small>
          </div>

          <dl className="rma-detail-list mobile-record-grid">
            <div>
              <dt>用户姓名</dt>
              <dd>{repairDetail.customer?.name || "未提供"}</dd>
            </div>

            <div>
              <dt>联系电话</dt>
              <dd>
                {repairDetail.customer?.phoneMasked || "未提供"}
              </dd>
            </div>

            <div>
              <dt>所在地区/地址</dt>
              <dd>{repairDetail.customer?.regionAddress || "未提供"}</dd>
            </div>
            <div>
              <dt>产品线</dt>
              <dd>{repairDetail.productLine || "未提供"}</dd>
            </div>

            <div>
              <dt>取件物流单号</dt>
              <dd>{repairDetail.pickupLogisticsNo}</dd>
            </div>
            <div>
              <dt>机器 SN</dt>
              <dd>{repairDetail.productSerialNo || "待录入"}</dd>
            </div>
          </dl>

          <div className="mobile-record-description">
            <span>用户报修描述</span>
            <p>{repairDetail.reportedFault || "未提供"}</p>
          </div>

          <MachineRepairHistory history={machineHistory} />

          {receiptMessage && (
            <p className="receipt-status-message" role="status">
              {receiptMessage}
            </p>
          )}

          {specialtyGate.error && (
            <p className="error-text receipt-permission-message">
              {specialtyGate.error}
            </p>
          )}

          {repairDetail.localWorkflow?.status
            && repairDetail.localWorkflow.status !== "MODEL_AUTHORIZATION_REVIEW" ? (
            <p className="receipt-status-message" role="status">
              已录入工单，无需重复录入 SN 或补签收照片
            </p>
          ) : (
            <button
              onClick={startReceiptPreparation}
              disabled={!currentUser || Boolean(authError || specialtyGate.error)}
            >
              下一步：录入 SN
            </button>
          )}

        </div>

      )}

      {repairDetail && receiptStep === "form" && (
        <div className="card receipt-preparation-card compact-receipt-card">
          <div className="rma-detail-heading">
            <h2>录入 SN 与签收准备</h2>
            <span className="read-only-badge">待录入</span>
          </div>
          <div className="mobile-record-hero receipt-form-hero">
            <span>寄修单号</span>
            <strong>{repairDetail.rmaNo}</strong>
            <small>{repairDetail.productLine || "待确认品类"}</small>
          </div>
          <dl className="rma-detail-list receipt-summary mobile-record-grid">
            <div>
              <dt>用户姓名</dt>
              <dd>{repairDetail.customer?.name || "未提供"}</dd>
            </div>
            <div>
              <dt>产品线</dt>
              <dd>{repairDetail.productLine || "未提供"}</dd>
            </div>
            <div>
              <dt>联系电话</dt>
              <dd>{repairDetail.customer?.phoneMasked || "未提供"}</dd>
            </div>
            <div>
              <dt>物流单号</dt>
              <dd>{queriedLogisticsNo || "送修（无物流单号）"}</dd>
            </div>
          </dl>
          <div className="mobile-record-description compact-note">
            <span>报修描述</span>
            <p>{repairDetail.reportedFault || "未提供"}</p>
          </div>

          <label htmlFor="receipt-sn">机器 SN <span className="inline-required">必填</span></label>
          <div className="scan-input-row">
            <input
              id="receipt-sn"
              value={sn}
              onChange={(event) => {
                setSn(event.target.value.toUpperCase())
                setErrorMessage("")
              }}
              onBlur={() => {
                const normalized = normalizeReceiptSn(sn)
                setSn(normalized)
                checkMachineHistory(normalized)
              }}
              placeholder="请输入、扫描枪输入或使用摄像头扫描"
              autoComplete="off"
            />
            <button
              className="scan-btn"
              aria-label={sn ? "重新扫描 SN" : "扫描 SN"}
              onClick={() => setScannerMode("sn")}
            >
              <ScanIcon />
            </button>
          </div>
          <MachineRepairHistory history={machineHistory} />
          <div className="sn-secondary-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setScannerMode("sn")}
            >
              {sn ? "重新扫码" : "扫码录入"}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setSn("")
                setMachineHistory(null)
                setErrorMessage("")
              }}
              disabled={!sn}
            >
              清空
            </button>
          </div>

          {!REPAIR_SPECIALTIES.includes(repairDetail.productLine) && specialtyGate.specialties.length > 1 ? (
            <>
              <label htmlFor="receipt-specialty">本单维修品类</label>
              <select
                id="receipt-specialty"
                value={specialty}
                onChange={(event) => {
                  setSpecialty(event.target.value)
                  setErrorMessage("")
                }}
              >
                <option value="">请选择维修品类</option>
                {specialtyGate.specialties.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </>
          ) : null}

          {specialty && (
            <p className="receipt-readonly-remark">
              签收备注：{specialty}
            </p>
          )}

          <section className="receipt-upload-section">
            <div className="receipt-upload-heading">
              <div>
                <strong>签收照片/视频</strong>
                <span>归属瑞云寄修单，与维修附件分开</span>
              </div>
              <span className="required-field-badge">必填</span>
            </div>
            <input
              id="receipt-album"
              className="visually-hidden-file"
              type="file"
              accept="image/*,video/*"
              multiple
              onChange={uploadReceiptFiles}
              disabled={isSaving}
            />
            <div className="receipt-upload-actions">
              <button type="button" className="receipt-upload-button camera-button" onClick={() => setPhotoCameraOpen(true)} disabled={isSaving}><CameraIcon size={18} />拍照</button>
              <label className="receipt-upload-button" htmlFor="receipt-album">▧ 从相册选择</label>
            </div>
            {receiptAttachments.length > 0 ? (
              <AttachmentPreviewList
                attachments={receiptAttachments}
                loadAttachment={(attachment) => downloadRepairAttachment(repairDetail.rmaNo, "receipt", attachment)}
                disabled={isSaving}
                onRemove={(attachmentId) => setReceiptAttachments((current) => current.filter((file) => file.id !== attachmentId))}
              />
            ) : <p className="receipt-upload-empty">到店签收时拍摄机器外观、包装及异常位置</p>}
          </section>

          <p className={receiptWriteEnabled ? "live-write-notice" : "dry-run-notice"}>
            {receiptWriteEnabled
              ? "真实签收模式：完成后将同步签收到瑞云"
              : "当前为演练模式，不会操作瑞云签收"}
          </p>

          {errorMessage && (
            <p className="error-text receipt-inline-error" role="alert">
              {errorMessage}
            </p>
          )}

          <div className="receipt-actions">
            <button className="secondary-button" onClick={() => setReceiptStep("detail")}>
              返回工单
            </button>
            <button onClick={finishReceiptAndOpenParts} disabled={isSaving || !sn.trim() || receiptAttachments.length === 0}>
              {isSaving ? "正在完成签收..." : "完成签收，选择处理方式"}
            </button>
          </div>
        </div>
      )}

      {scannerMode && (

        <ScannerModal
          open={Boolean(scannerMode)}
          mode={scannerMode}
          title={scannerMode === "sn" ? "扫描机器 SN" : "扫描物流单号"}
          onScan={(code) => {
            if (scannerMode === "sn") {
              const scannedSn = normalizeReceiptSn(code)
              const scanError = validateReceiptSn(
                scannedSn,
                repairDetail?.logisticsNo || orderNo
              )
              if (scanError) {
                setErrorMessage(scanError)
              } else {
                setSn(scannedSn)
                checkMachineHistory(scannedSn)
                setErrorMessage("")
              }
            } else {
              setOrderNo(code)
              resetResult()
            }
            setScannerMode("")
          }}
          onClose={() => setScannerMode("")}
        />

      )}

      <PhotoCaptureModal
        open={photoCameraOpen}
        onCapture={(file) => saveReceiptFiles([file])}
        onClose={() => setPhotoCameraOpen(false)}
      />

    </div>

  )

}


export default Repair
