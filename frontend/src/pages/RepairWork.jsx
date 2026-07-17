import { useEffect, useMemo, useState } from "react"

import {
  getInventory,
  saveInventory
} from "../shared/inventoryStore.js"

import {
  getCurrentRepairOrder,
  updateRepairOrder,
  updateRepairStatus
} from "../shared/repairOrderStore.js"


function RepairWork({ setPage }) {

  const technicianName = "张师傅"


  const [repairOrder, setRepairOrder] = useState(() =>
    getCurrentRepairOrder()
  )

  const [inventory, setInventory] = useState(() =>
    getInventory()
  )

  const [sn, setSn] = useState(
    repairOrder.sn || ""
  )

  const [keyword, setKeyword] = useState("")
  const [selectedPart, setSelectedPart] = useState(null)
  const [quantity, setQuantity] = useState(1)
  const [message, setMessage] = useState("")


  const [appliedParts, setAppliedParts] = useState(() => {

    try {

      return JSON.parse(
        localStorage.getItem("currentRepairParts") || "[]"
      )

    } catch (error) {

      console.error("当前配件数据读取失败：", error)

      return []

    }

  })


  useEffect(() => {

    const updatedOrder = updateRepairStatus("维修中")

    setRepairOrder(updatedOrder)

  }, [])


  const technicianParts =
    inventory.technicianStock[technicianName] || []


  const searchResults = useMemo(() => {

    const text = keyword.trim().toLowerCase()

    if (text === "" || selectedPart) {
      return []
    }

    return inventory.totalStock.filter((item) => {

      return (
        item.code.toLowerCase().includes(text) ||
        item.name.toLowerCase().includes(text)
      )

    })

  }, [
    keyword,
    selectedPart,
    inventory.totalStock
  ])


  function getTechnicianStock(partCode) {

    const part = technicianParts.find(
      (item) => item.code === partCode
    )

    return part?.stock || 0
  }


  function handleSnChange(event) {

    const value = event.target.value

    setSn(value)

    const updatedOrder = updateRepairOrder({
      sn: value
    })

    setRepairOrder(updatedOrder)
  }


  function handleKeywordChange(event) {

    setKeyword(event.target.value)
    setSelectedPart(null)
    setMessage("")
  }


  function choosePart(part) {

    setSelectedPart(part)
    setKeyword(`${part.code} ${part.name}`)
    setQuantity(1)
    setMessage("")
  }


  function applyPart() {

    if (sn.trim() === "") {

      setMessage("请先填写机器 SN")

      return

    }


    if (!selectedPart) {

      setMessage("请先从搜索结果中选择配件")

      return

    }


    const requestQuantity = Number(quantity)


    if (
      !Number.isInteger(requestQuantity) ||
      requestQuantity <= 0
    ) {

      setMessage("申请数量必须是大于 0 的整数")

      return

    }


    if (selectedPart.stock < requestQuantity) {

      const updatedOrder = updateRepairStatus("等待配件")

      setRepairOrder(updatedOrder)

      setMessage(
        `总库库存不足，当前最多可申请 ${selectedPart.stock} 个，机器状态已自动变更为“等待配件”`
      )

      return

    }


    const updatedInventory = structuredClone(inventory)


    const totalPart = updatedInventory.totalStock.find(
      (item) => item.code === selectedPart.code
    )


    if (!totalPart) {

      setMessage("库存中没有找到该配件")

      return

    }


    totalPart.stock -= requestQuantity


    if (!updatedInventory.technicianStock[technicianName]) {

      updatedInventory.technicianStock[technicianName] = []

    }


    const currentTechnicianParts =
      updatedInventory.technicianStock[technicianName]


    const technicianPart = currentTechnicianParts.find(
      (item) => item.code === selectedPart.code
    )


    if (technicianPart) {

      technicianPart.stock += requestQuantity

    } else {

      currentTechnicianParts.push({
        code: selectedPart.code,
        name: selectedPart.name,
        stock: requestQuantity
      })

    }


    saveInventory(updatedInventory)

    setInventory(updatedInventory)


    const existingAppliedPart = appliedParts.find(
      (item) => item.code === selectedPart.code
    )


    let updatedAppliedParts


    if (existingAppliedPart) {

      updatedAppliedParts = appliedParts.map((item) => {

        if (item.code !== selectedPart.code) {
          return item
        }

        return {
          ...item,
          quantity: item.quantity + requestQuantity,
          sn: sn.trim()
        }

      })

    } else {

      updatedAppliedParts = [
        ...appliedParts,
        {
          id: `${selectedPart.code}-${Date.now()}`,
          code: selectedPart.code,
          name: selectedPart.name,
          quantity: requestQuantity,
          technician: technicianName,
          sn: sn.trim(),
          usageStatus: "used",
          status: "已申请"
        }
      ]

    }


    setAppliedParts(updatedAppliedParts)


    localStorage.setItem(
      "currentRepairParts",
      JSON.stringify(updatedAppliedParts)
    )


    const updatedOrder = updateRepairStatus("维修中")

    setRepairOrder(updatedOrder)


    setMessage(
      `${selectedPart.name} × ${requestQuantity} 申请成功`
    )


    setKeyword("")
    setSelectedPart(null)
    setQuantity(1)
  }


  function removeAppliedPart(part) {

    const updatedInventory = structuredClone(inventory)


    const totalPart = updatedInventory.totalStock.find(
      (item) => item.code === part.code
    )


    const technicianPart =
      updatedInventory.technicianStock[technicianName]?.find(
        (item) => item.code === part.code
      )


    if (totalPart) {

      totalPart.stock += part.quantity

    }


    if (technicianPart) {

      technicianPart.stock = Math.max(
        0,
        technicianPart.stock - part.quantity
      )

    }


    const updatedAppliedParts = appliedParts.filter(
      (item) => item.id !== part.id
    )


    saveInventory(updatedInventory)

    setInventory(updatedInventory)
    setAppliedParts(updatedAppliedParts)


    localStorage.setItem(
      "currentRepairParts",
      JSON.stringify(updatedAppliedParts)
    )


    setMessage(
      `${part.name}申请已取消，库存已恢复`
    )
  }


  function handleBackToRepairList() {

    const updatedOrder = updateRepairStatus("暂停维修")

    setRepairOrder(updatedOrder)


    localStorage.setItem(
      "currentRepairParts",
      JSON.stringify(appliedParts)
    )


    setPage("repair")
  }


  function handleRepairFinish() {

    if (sn.trim() === "") {

      setMessage("请先填写机器 SN")

      return

    }


    const updatedOrder = updateRepairOrder({
      sn: sn.trim(),
      technician: technicianName,
      status: "待维修确认"
    })


    setRepairOrder(updatedOrder)


    localStorage.setItem(
      "currentRepair",
      JSON.stringify(updatedOrder)
    )


    localStorage.setItem(
      "currentRepairParts",
      JSON.stringify(appliedParts)
    )


    setPage("repairFinish")
  }


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


  return (

    <div className="page repair-work-page">


      <div className="page-header-row">

        <button
          type="button"
          className="compact-back-button"
          onClick={handleBackToRepairList}
        >
          <span className="back-arrow">
            ‹
          </span>

          返回
        </button>

      </div>


      <h1>
        维修工作台
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

  {repairOrder.sn || "-"}
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
          配件申请
        </h2>


        <input
          value={keyword}
          onChange={handleKeywordChange}
          placeholder="输入物料编码或配件名称"
        />


        {searchResults.length > 0 && (

          <div className="part-search-results">

            {searchResults.map((item) => (

              <button
                type="button"
                className="part-search-item"
                key={item.code}
                onClick={() => choosePart(item)}
              >

                <strong>
                  {item.name}
                </strong>


                <span>
                  物料编码：{item.code}
                </span>


                <span>
                  总库库存：{item.stock}
                </span>


                <span>
                  师傅库存：
                  {getTechnicianStock(item.code)}
                </span>

              </button>

            ))}

          </div>

        )}


        {keyword.trim() !== "" &&
          !selectedPart &&
          searchResults.length === 0 && (

            <p className="error-text">
              没有找到匹配的配件
            </p>

          )}

      </div>


      {selectedPart && (

        <div className="card">

          <h2>
            配件库存详情
          </h2>


          <p>
            物料编码：
            {selectedPart.code}
          </p>


          <p>
            配件名称：
            {selectedPart.name}
          </p>


          <p>
            公司总库存：
            {selectedPart.stock}
          </p>


          <p>
            师傅个人库存：
            {getTechnicianStock(selectedPart.code)}
          </p>


          <label htmlFor="apply-quantity">
            申请数量
          </label>


          <input
            id="apply-quantity"
            type="number"
            min="1"
            step="1"
            value={quantity}
            onChange={(event) =>
              setQuantity(Number(event.target.value))
            }
          />


          <button
            type="button"
            onClick={applyPart}
          >
            申请配件
          </button>

        </div>

      )}


      <div className="card">

        <h2>
          本次已申请配件
        </h2>


        {appliedParts.length === 0 ? (

          <p>
            暂无申请配件
          </p>

        ) : (

          appliedParts.map((item) => (

            <div
              className="inventory-item"
              key={item.id}
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
                申请数量：{item.quantity}
              </p>


              <p>
                绑定 SN：{item.sn}
              </p>


              <button
                type="button"
                className="cancel-part-button"
                onClick={() => removeAppliedPart(item)}
              >
                取消申请
              </button>

            </div>

          ))

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
        onClick={handleRepairFinish}
      >
        维修完成，进入确认
      </button>

    </div>

  )

}


export default RepairWork