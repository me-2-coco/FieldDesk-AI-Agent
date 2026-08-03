import { useEffect, useState } from "react"
import ScannerModal from "../components/ScannerModal"
import {
  cancelReceiptPreparation,
  completeLocalReceipt,
  getCurrentFieldDeskUser,
  prepareReceipt,
  queryCrmOrderByLogisticsNo
} from "../shared/crmService.js"
import {
  createRepairOrder,
  REPAIR_STATUS,
  saveCurrentRepairOrder
} from "../shared/repairOrderStore.js"
import {
  getReceiptSpecialtyGate,
  normalizeReceiptSn,
  validateReceiptSn
} from "../shared/receiptPreparation.js"


function Repair({ setPage }) {

  const [orderNo, setOrderNo] = useState("")
  const [scannerMode, setScannerMode] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [repairDetail, setRepairDetail] = useState(null)
  const [errorMessage, setErrorMessage] = useState("")
  const [receiptStep, setReceiptStep] = useState("detail")
  const [sn, setSn] = useState("")
  const [specialty, setSpecialty] = useState("")
  const [receiptMessage, setReceiptMessage] = useState("")
  const [isSaving, setIsSaving] = useState(false)
  const [currentUser, setCurrentUser] = useState(null)
  const [authError, setAuthError] = useState("")
  const specialtyGate = getReceiptSpecialtyGate(
    currentUser,
    repairDetail?.productLine
  )
  const hasFullPhone = /^1[3-9]\d{9}$/.test(
    repairDetail?.customer?.phoneMasked || ""
  )

  useEffect(() => {
    getCurrentFieldDeskUser()
      .then((user) => {
        setCurrentUser(user)
        setAuthError("")
      })
      .catch((error) => setAuthError(error.message))
  }, [])

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
      setReceiptStep("detail")
      setReceiptMessage("")

    } catch (error) {
      setErrorMessage(error.message)

    } finally {
      setIsLoading(false)
    }

  }


  function resetResult() {
    setErrorMessage("")
    setRepairDetail(null)
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
    setSn("")
    setSpecialty(specialtyGate.specialty)
    setErrorMessage("")
    setReceiptMessage("")
    setReceiptStep("form")
  }

  function reviewReceiptPreparation() {
    const normalizedSn = normalizeReceiptSn(sn)
    const snError = validateReceiptSn(
      normalizedSn,
      repairDetail.logisticsNo || orderNo
    )
    if (snError) {
      setErrorMessage(snError)
      return
    }
    if (!specialty) {
      setErrorMessage("请选择本单维修品类")
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
    setSn(normalizedSn)
    setErrorMessage("")
    setReceiptStep("confirm")
  }

  async function saveReceiptPreparation() {
    try {
      setIsSaving(true)
      setErrorMessage("")
      const result = await prepareReceipt({
        logisticsNo: repairDetail.logisticsNo || orderNo.trim(),
        rmaNo: repairDetail.rmaNo,
        sn,
        specialty,
        productLine: repairDetail.productLine || "",
        customerName: repairDetail.customer?.name || "",
        phoneMasked: repairDetail.customer?.phoneMasked || "",
        reportedFault: repairDetail.reportedFault
      })
      setReceiptMessage(
        result.message || "签收资料已准备，尚未同步瑞云"
      )
      setReceiptStep("saved")
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setIsSaving(false)
    }
  }

  async function cancelPreparation() {
    try {
      setIsSaving(true)
      setErrorMessage("")
      const result = await cancelReceiptPreparation(repairDetail.rmaNo)
      setReceiptMessage(result.message || "签收准备已取消，未操作瑞云")
      setReceiptStep("detail")
      setSn("")
      setSpecialty("")
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setIsSaving(false)
    }
  }

  async function completeReceiptAndInspect() {
    try {
      setIsSaving(true)
      setErrorMessage("")
      const result = await completeLocalReceipt(repairDetail.rmaNo)
      const order = createRepairOrder({
        id: `RMA-${result.rmaNo}`,
        crmOrderNo: result.rmaNo,
        logisticsNo: result.logisticsNo,
        customer: result.customerName,
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
      setPage("repairProcess")
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setIsSaving(false)
    }
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
            onClick={() => setScannerMode("logistics")}
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


      {repairDetail && receiptStep === "detail" && (

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
              <dd>{repairDetail.customer?.name || "未提供"}</dd>
            </div>

            <div>
              <dt>联系电话</dt>
              <dd>
                {repairDetail.customer?.phoneMasked || "未提供"}
                {hasFullPhone && (
                  <span className="sensitive-info-badge">
                    敏感信息
                  </span>
                )}
              </dd>
            </div>

            <div>
              <dt>所在地区/地址</dt>
              <dd>{repairDetail.customer?.regionAddress || "未提供"}</dd>
            </div>

            <div>
              <dt>用户报修描述</dt>
              <dd>{repairDetail.reportedFault}</dd>
            </div>

            <div>
              <dt>产品线</dt>
              <dd>{repairDetail.productLine || "未提供"}</dd>
            </div>

            <div>
              <dt>取件物流单号</dt>
              <dd>{repairDetail.pickupLogisticsNo}</dd>
            </div>

          </dl>

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

          <button
            onClick={startReceiptPreparation}
            disabled={!currentUser || Boolean(authError || specialtyGate.error)}
          >
            下一步：录入 SN
          </button>

        </div>

      )}

      {repairDetail && receiptStep === "form" && (
        <div className="card receipt-preparation-card">
          <h2>录入 SN 与签收准备</h2>
          <dl className="rma-detail-list receipt-summary">
            <div><dt>寄修单号</dt><dd>{repairDetail.rmaNo}</dd></div>
            <div>
              <dt>物流单号</dt>
              <dd>{repairDetail.logisticsNo || orderNo.trim()}</dd>
            </div>
            <div>
              <dt>用户姓名</dt>
              <dd>{repairDetail.customer?.name || "未提供"}</dd>
            </div>
            <div>
              <dt>报修描述</dt>
              <dd>{repairDetail.reportedFault}</dd>
            </div>
            <div>
              <dt>产品线</dt>
              <dd>{repairDetail.productLine || "未提供"}</dd>
            </div>
          </dl>

          <label htmlFor="receipt-sn">机器 SN</label>
          <div className="scan-input-row">
            <input
              id="receipt-sn"
              value={sn}
              onChange={(event) => {
                setSn(event.target.value.toUpperCase())
                setErrorMessage("")
              }}
              onBlur={() => setSn(normalizeReceiptSn(sn))}
              placeholder="请输入、扫描枪输入或使用摄像头扫描"
              autoComplete="off"
            />
            <button
              className="scan-btn"
              aria-label={sn ? "重新扫描 SN" : "扫描 SN"}
              onClick={() => setScannerMode("sn")}
            >
              📷
            </button>
          </div>
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
                setErrorMessage("")
              }}
              disabled={!sn}
            >
              清空
            </button>
          </div>

          {specialtyGate.specialties.length > 1 ? (
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

          <p className="dry-run-notice">
            当前为演练模式，不会操作瑞云签收
          </p>

          <div className="receipt-actions">
            <button className="secondary-button" onClick={() => setReceiptStep("detail")}>
              返回工单
            </button>
            <button onClick={reviewReceiptPreparation}>
              下一步：确认资料
            </button>
          </div>
        </div>
      )}

      {repairDetail && receiptStep === "confirm" && (
        <div className="card receipt-preparation-card">
          <h2>确认签收准备资料</h2>
          <dl className="rma-detail-list">
            <div>
              <dt>操作师傅</dt>
              <dd>{currentUser?.displayName || "本地测试用户"}</dd>
            </div>
            <div><dt>维修品类</dt><dd>{specialty}</dd></div>
            <div><dt>签收备注</dt><dd>{specialty}</dd></div>
            <div><dt>SN</dt><dd>{sn}</dd></div>
            <div><dt>寄修单号</dt><dd>{repairDetail.rmaNo}</dd></div>
            <div>
              <dt>物流单号</dt>
              <dd>{repairDetail.logisticsNo || orderNo.trim()}</dd>
            </div>
          </dl>
          <p className="dry-run-notice">
            当前为演练模式，不会操作瑞云签收
          </p>
          <div className="receipt-actions">
            <button
              className="secondary-button"
              onClick={() => setReceiptStep("form")}
              disabled={isSaving}
            >
              返回修改
            </button>
            <button onClick={saveReceiptPreparation} disabled={isSaving}>
              {isSaving ? "正在保存..." : "确认保存到 FieldDesk"}
            </button>
          </div>
        </div>
      )}

      {repairDetail && receiptStep === "saved" && (
        <div className="card receipt-preparation-card receipt-success-card">
          <h2>签收准备完成</h2>
          <p className="receipt-status-message" role="status">
            {receiptMessage || "签收资料已准备，尚未同步瑞云"}
          </p>
          <dl className="rma-detail-list">
            <div><dt>SN</dt><dd>{sn}</dd></div>
            <div><dt>维修品类</dt><dd>{specialty}</dd></div>
            <div><dt>签收备注</dt><dd>{specialty}</dd></div>
            <div><dt>状态</dt><dd>RECEIPT_PREPARED</dd></div>
          </dl>
          <p className="dry-run-notice">
            当前为演练模式，不会操作瑞云签收
          </p>
          <div className="receipt-actions">
            <button
              onClick={completeReceiptAndInspect}
              disabled={isSaving}
            >
              {isSaving ? "正在处理..." : "完成本地签收并进入检测"}
            </button>
            <button
              className="secondary-button"
              onClick={() => setReceiptStep("form")}
              disabled={isSaving}
            >
              返回修改
            </button>
            <button
              className="danger-outline-button"
              onClick={cancelPreparation}
              disabled={isSaving}
            >
              {isSaving ? "正在处理..." : "取消准备"}
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

    </div>

  )

}


export default Repair
