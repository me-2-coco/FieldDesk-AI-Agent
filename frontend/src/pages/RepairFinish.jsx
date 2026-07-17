import { useEffect, useMemo, useState } from "react"

import crmFaults from "../data/crmFaults.js"

import {
  getCurrentRepairOrder,
  updateRepairOrder,
  updateRepairStatus
} from "../shared/repairOrderStore.js"


function RepairFinish({ setPage }) {

  const [repairOrder, setRepairOrder] = useState(() =>
    getCurrentRepairOrder()
  )


  const [parts, setParts] = useState(() => {

    try {

      const savedParts = JSON.parse(
        localStorage.getItem("currentRepairParts") || "[]"
      )

      return savedParts.map((item) => ({
        ...item,
        usageStatus: item.usageStatus || "used"
      }))

    } catch (error) {

      console.error("维修配件数据读取失败：", error)

      return []

    }

  })


  const [keyword, setKeyword] = useState("")
  const [selectedFault, setSelectedFault] = useState(null)
  const [inspectionResult, setInspectionResult] = useState("")
  const [responsibility, setResponsibility] = useState("")
  const [files, setFiles] = useState([])
  const [message, setMessage] = useState("")
  const [submitting, setSubmitting] = useState(false)


  useEffect(() => {

    const updatedOrder = updateRepairStatus("待维修确认")

    setRepairOrder(updatedOrder)

  }, [])


  const searchResults = useMemo(() => {

    const text = keyword.trim().toLowerCase()

    if (text === "" || selectedFault) {
      return []
    }


    return crmFaults.filter((item) => {

      const system = String(item.system || "").toLowerCase()
      const fault = String(item.fault || "").toLowerCase()
      const itemKeyword = String(item.keyword || "").toLowerCase()
      const solution = String(item.solution || "").toLowerCase()
      const part = String(item.part || "").toLowerCase()

      return (
        system.includes(text) ||
        fault.includes(text) ||
        itemKeyword.includes(text) ||
        solution.includes(text) ||
        part.includes(text)
      )

    })

  }, [
    keyword,
    selectedFault
  ])


  function getStatusClassName(status) {

    const statusClassMap = {
      "待维修": "status-waiting",
      "维修中": "status-working",
      "暂停维修": "status-paused",
      "等待配件": "status-parts",
      "待维修确认": "status-confirm",
      "已完成": "status-completed"
    }

    return statusClassMap[status] || "status-default"
  }


  function handleBackToRepairWork() {

    const updatedOrder = updateRepairStatus("维修中")

    setRepairOrder(updatedOrder)


    localStorage.setItem(
      "currentRepairParts",
      JSON.stringify(parts)
    )


    setPage("repairWork")
  }


  function handleKeywordChange(event) {

    setKeyword(event.target.value)
    setSelectedFault(null)
    setMessage("")
  }


  function chooseFault(item) {

    setSelectedFault(item)
    setKeyword(item.fault)
    setMessage("")
  }


  function clearSelectedFault() {

    setSelectedFault(null)
    setKeyword("")
    setMessage("")
  }


  function updatePartStatus(partId, status) {

    setParts((currentParts) => {

      const updatedParts = currentParts.map((item) =>
        item.id === partId
          ? {
              ...item,
              usageStatus: status
            }
          : item
      )


      localStorage.setItem(
        "currentRepairParts",
        JSON.stringify(updatedParts)
      )


      return updatedParts

    })

  }


  function handleFiles(event) {

    const selectedFiles = Array.from(
      event.target.files || []
    )

    setFiles(selectedFiles)
  }


  function createReturnRequests(
    returnParts,
    completedRecord,
    completedAt
  ) {

    if (returnParts.length === 0) {
      return
    }


    let oldRequests = []

    try {

      oldRequests = JSON.parse(
        localStorage.getItem("partReturnRequests") || "[]"
      )

    } catch (error) {

      console.error("归还申请数据读取失败：", error)

      oldRequests = []

    }


    const newRequests = returnParts.map((item, index) => ({

      id:
        `RETURN-${completedRecord.id}-${item.code}-${index}`,

      repairOrderId: completedRecord.orderId,

      technician:
        completedRecord.technician,

      sn:
        completedRecord.sn,

      partCode:
        item.code,

      partName:
        item.name,

      quantity:
        Number(item.quantity) || 0,

      status:
        "待库房确认",

      createdAt:
        completedAt

    }))


    localStorage.setItem(
      "partReturnRequests",
      JSON.stringify([
        ...oldRequests,
        ...newRequests
      ])
    )

  }


  function createScrapRequests(
    scrapParts,
    completedRecord,
    completedAt
  ) {

    if (scrapParts.length === 0) {
      return
    }


    let oldRequests = []

    try {

      oldRequests = JSON.parse(
        localStorage.getItem("partScrapRequests") || "[]"
      )

    } catch (error) {

      console.error("报废申请数据读取失败：", error)

      oldRequests = []

    }


    const newRequests = scrapParts.map((item, index) => ({

      id:
        `SCRAP-${completedRecord.id}-${item.code}-${index}`,

      repairOrderId:
        completedRecord.orderId,

      technician:
        completedRecord.technician,

      sn:
        completedRecord.sn,

      partCode:
        item.code,

      partName:
        item.name,

      quantity:
        Number(item.quantity) || 0,

      status:
        "待报废审核",

      createdAt:
        completedAt

    }))


    localStorage.setItem(
      "partScrapRequests",
      JSON.stringify([
        ...oldRequests,
        ...newRequests
      ])
    )

  }


  function submitRepair() {

    if (submitting) {
      return
    }


    if (!repairOrder.sn?.trim()) {

      setMessage("当前维修机器没有填写 SN")

      return

    }


    if (!selectedFault) {

      setMessage("请先选择 CRM 三级故障")

      return

    }


    if (inspectionResult.trim() === "") {

      setMessage("请填写实际检测结果")

      return

    }


    if (responsibility === "") {

      setMessage("请选择责任判定")

      return

    }


    const pendingPart = parts.find(
      (item) => item.usageStatus === "pending"
    )


    if (pendingPart) {

      setMessage(
        `请确认配件“${pendingPart.name}”的使用情况`
      )

      return

    }


    setSubmitting(true)
    setMessage("")


    const now = new Date()
    const recordId = Date.now()
    const completedAt = now.toLocaleString()


    const usedParts = parts.filter(
      (item) => item.usageStatus === "used"
    )

    const returnParts = parts.filter(
      (item) => item.usageStatus === "return"
    )

    const scrapParts = parts.filter(
      (item) => item.usageStatus === "scrap"
    )


    const completedOrder = updateRepairOrder({

      status: "已完成",

      faultSystem:
        selectedFault.system,

      level3Fault:
        selectedFault.fault,

      solution:
        selectedFault.solution,

      relatedPart:
        selectedFault.part,

      inspectionResult:
        inspectionResult.trim(),

      responsibility,

      completedAt

    })


    setRepairOrder(completedOrder)


    const completedRecord = {

      id:
        recordId,

      orderId:
        completedOrder.id || `FD-${recordId}`,

      technician:
        completedOrder.technician || "张师傅",

      customer:
        completedOrder.customer || "张三",

      phone:
        completedOrder.phone || "13888888888",

      product:
        completedOrder.product || "扫地机器人 X1",

      sn:
        completedOrder.sn,

      originalFault:
        completedOrder.originalFault || "无法开机",

      faultSystem:
        selectedFault.system,

      level3Fault:
        selectedFault.fault,

      solution:
        selectedFault.solution,

      relatedPart:
        selectedFault.part,

      inspectionResult:
        inspectionResult.trim(),

      responsibility,

      parts,

      usedParts,

      returnParts,

      scrapParts,

      fileCount:
        files.length,

      fileNames:
        files.map((file) => file.name),

      status:
        "已完成",

      date:
        now.toLocaleDateString(),

      completedAt

    }


    let oldRecords = []

    try {

      oldRecords = JSON.parse(
        localStorage.getItem("repairRecords") || "[]"
      )

    } catch (error) {

      console.error("维修记录读取失败：", error)

      oldRecords = []

    }


    localStorage.setItem(
      "repairRecords",
      JSON.stringify([
        ...oldRecords,
        completedRecord
      ])
    )


    createReturnRequests(
      returnParts,
      completedRecord,
      completedAt
    )


    createScrapRequests(
      scrapParts,
      completedRecord,
      completedAt
    )


    localStorage.removeItem("currentRepair")
    localStorage.removeItem("currentRepairParts")


    setMessage("维修完成，维修记录已保存")


    setTimeout(() => {

      setSubmitting(false)

      setPage("records")

    }, 700)

  }


  return (

    <div className="page repair-finish-page">


      <div className="page-header-row">

        <button
          type="button"
          className="compact-back-button"
          onClick={handleBackToRepairWork}
        >
          <span className="back-arrow">
            ‹
          </span>

          返回
        </button>

      </div>


      <h1>
        维修完成确认
      </h1>


      <div className="card">

        <div className="machine-card-header">

          <h2>
            机器信息
          </h2>


          <span
            className={
              `repair-status-badge ${getStatusClassName(
                repairOrder.status
              )}`
            }
          >
            {repairOrder.status}
          </span>

        </div>


        <div className="machine-info-list">

          <p>
            <span className="info-label">
              客户：
            </span>

            {repairOrder.customer || "张三"}
          </p>


          <p>
            <span className="info-label">
              电话：
            </span>

            {repairOrder.phone || "138****8888"}
          </p>


          <p>
            <span className="info-label">
              产品：
            </span>

            {repairOrder.product || "扫地机器人 X1"}
          </p>


          <p>
            <span className="info-label">
              SN：
            </span>

            {repairOrder.sn || "未填写"}
          </p>


          <p>
            <span className="info-label">
              用户故障描述：
            </span>

            {repairOrder.originalFault || "无法开机"}
          </p>

        </div>


        <div className="status-time-row">

          <span>
            状态更新时间
          </span>

          <span>
            {repairOrder.statusUpdatedAt || "-"}
          </span>

        </div>

      </div>


      <div className="card">

        <h2>
          CRM三级故障
        </h2>


        <input
          value={keyword}
          onChange={handleKeywordChange}
          placeholder="输入关键词，例如：电池、主板、电机"
        />


        {searchResults.length > 0 && (

          <div className="part-search-results">

            {searchResults.map((item, index) => (

              <button
                type="button"
                className="part-search-item"
                key={`${item.system}-${item.fault}-${index}`}
                onClick={() => chooseFault(item)}
              >

                <strong>
                  {item.fault}
                </strong>


                <span>
                  故障系统：{item.system}
                </span>


                <span>
                  维修方案：{item.solution}
                </span>


                <span>
                  关联配件：{item.part || "无"}
                </span>

              </button>

            ))}

          </div>

        )}


        {keyword.trim() !== "" &&
          !selectedFault &&
          searchResults.length === 0 && (

            <p className="error-text">
              没有找到匹配的 CRM 三级故障
            </p>

          )}

      </div>


      {selectedFault && (

        <div className="card">

          <div className="selected-fault-header">

            <h2>
              已选择故障
            </h2>


            <button
              type="button"
              className="small-text-button"
              onClick={clearSelectedFault}
            >
              重新选择
            </button>

          </div>


          <p>
            故障系统：
            {selectedFault.system}
          </p>


          <p>
            三级故障：
            {selectedFault.fault}
          </p>


          <p>
            维修方案：
            {selectedFault.solution}
          </p>


          <p>
            关联配件：
            {selectedFault.part || "无"}
          </p>

        </div>

      )}


      <div className="card">

        <h2>
          检测结果
        </h2>


        <textarea
          value={inspectionResult}
          onChange={(event) =>
            setInspectionResult(event.target.value)
          }
          placeholder="填写实际检测情况，例如：电池电压异常，无法正常充电"
        />

      </div>


      <div className="card">

        <h2>
          责任判定
        </h2>


        <label htmlFor="repair-responsibility">
          保内或保外
        </label>


        <select
          id="repair-responsibility"
          value={responsibility}
          onChange={(event) =>
            setResponsibility(event.target.value)
          }
        >
          <option value="">
            请选择责任判定
          </option>

          <option value="保内">
            保内
          </option>

          <option value="保外">
            保外
          </option>

          <option value="待确认">
            待确认
          </option>
        </select>

      </div>


      <div className="card">

        <h2>
          配件更换确认
        </h2>


        {parts.length === 0 ? (

          <p>
            本次维修没有申请配件
          </p>

        ) : (

          parts.map((item) => (

            <div
              className="inventory-item"
              key={item.id || item.code}
            >

              <p>
                <strong>
                  {item.name}
                </strong>
              </p>


              <p>
                物料编码：{item.code}
              </p>


              <p>
                领取数量：{item.quantity}
              </p>


              <label
                htmlFor={`part-status-${item.id || item.code}`}
              >
                配件处理结果
              </label>


              <select
                id={`part-status-${item.id || item.code}`}
                value={item.usageStatus}
                onChange={(event) =>
                  updatePartStatus(
                    item.id,
                    event.target.value
                  )
                }
              >
                <option value="used">
                  已更换
                </option>

                <option value="return">
                  未使用，申请归还
                </option>

                <option value="scrap">
                  损坏或报废
                </option>

                <option value="pending">
                  暂未确认
                </option>
              </select>

            </div>

          ))

        )}

      </div>


      <div className="card">

        <h2>
          上传维修资料
        </h2>


        <input
          type="file"
          multiple
          accept="image/*,video/*"
          onChange={handleFiles}
        />


        <p>
          已选择文件：{files.length} 个
        </p>


        {files.length > 0 && (

          <div className="selected-file-list">

            {files.map((file) => (

              <p key={`${file.name}-${file.size}`}>
                {file.name}
              </p>

            ))}

          </div>

        )}

      </div>


      {message && (

        <div className="card message-card">

          <p>
            {message}
          </p>

        </div>

      )}


      <button
        type="button"
        className="finish"
        disabled={submitting}
        onClick={submitRepair}
      >
        {submitting
          ? "正在提交..."
          : "提交维修完成"}
      </button>

    </div>

  )

}


export default RepairFinish