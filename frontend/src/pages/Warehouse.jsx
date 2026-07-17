import { useState } from "react"
import {
  getInventory,
  saveInventory
} from "../shared/inventoryStore.js"


function Warehouse() {

  const [inventory, setInventory] = useState(() =>
    getInventory()
  )

  const [returnRequests, setReturnRequests] = useState(() => {
    try {
      return JSON.parse(
        localStorage.getItem("partReturnRequests") || "[]"
      )
    } catch {
      return []
    }
  })

  const [message, setMessage] = useState("")


  function approveReturn(request) {

    if (request.status !== "待库房确认") {
      return
    }

    const updatedInventory = structuredClone(inventory)

    const technicianParts =
      updatedInventory.technicianStock[request.technician] || []

    const technicianPart = technicianParts.find(
      (item) => item.code === request.partCode
    )

    const totalPart = updatedInventory.totalStock.find(
      (item) => item.code === request.partCode
    )


    if (!technicianPart) {
      setMessage("没有找到该师傅的对应配件库存")
      return
    }


    if (technicianPart.stock < request.quantity) {
      setMessage(
        `${request.technician}的个人库存不足，不能确认归还`
      )
      return
    }


    technicianPart.stock -= request.quantity


    if (totalPart) {
      totalPart.stock += request.quantity
    } else {
      updatedInventory.totalStock.push({
        code: request.partCode,
        name: request.partName,
        stock: request.quantity
      })
    }


    const updatedRequests = returnRequests.map((item) =>
      item.id === request.id
        ? {
            ...item,
            status: "已确认归还",
            confirmedAt: new Date().toLocaleString()
          }
        : item
    )


    saveInventory(updatedInventory)

    localStorage.setItem(
      "partReturnRequests",
      JSON.stringify(updatedRequests)
    )

    setInventory(updatedInventory)
    setReturnRequests(updatedRequests)

    setMessage(
      `${request.partName} × ${request.quantity} 已确认归还`
    )
  }


  const pendingRequests = returnRequests.filter(
    (item) => item.status === "待库房确认"
  )

  const completedRequests = returnRequests.filter(
    (item) => item.status === "已确认归还"
  )


  return (
    <div className="page">

      <h1>库房管理</h1>


      <div className="card">

        <h2>待确认归还配件</h2>

        {pendingRequests.length === 0 ? (
          <p>当前没有待确认归还申请</p>
        ) : (
          pendingRequests
            .slice()
            .reverse()
            .map((item) => (
              <div
                className="inventory-item"
                key={item.id}
              >
                <p>
                  <strong>{item.partName}</strong>
                </p>

                <p>物料编码：{item.partCode}</p>
                <p>数量：{item.quantity}</p>
                <p>申请师傅：{item.technician}</p>
                <p>绑定 SN：{item.sn}</p>
                <p>申请时间：{item.createdAt || "-"}</p>
                <p>状态：{item.status}</p>

                <button
                  className="green"
                  onClick={() => approveReturn(item)}
                >
                  同意归还
                </button>
              </div>
            ))
        )}

      </div>


      <div className="card">

        <h2>师傅个人库存</h2>

        {Object.entries(inventory.technicianStock).map(
          ([technician, parts]) => (
            <div
              className="inventory-item"
              key={technician}
            >
              <h3>{technician}</h3>

              {parts.length === 0 ? (
                <p>暂无个人库存</p>
              ) : (
                parts.map((part) => (
                  <p key={`${technician}-${part.code}`}>
                    {part.name}（{part.code}）：{part.stock}
                  </p>
                ))
              )}
            </div>
          )
        )}

      </div>


      <div className="card">

        <h2>公司总库存</h2>

        {inventory.totalStock.map((part) => (
          <div
            className="inventory-item"
            key={part.code}
          >
            <p>
              <strong>{part.name}</strong>
            </p>

            <p>物料编码：{part.code}</p>
            <p>总库库存：{part.stock}</p>
          </div>
        ))}

      </div>


      <div className="card">

        <h2>已确认归还记录</h2>

        {completedRequests.length === 0 ? (
          <p>暂无已确认归还记录</p>
        ) : (
          completedRequests
            .slice()
            .reverse()
            .map((item) => (
              <div
                className="inventory-item"
                key={item.id}
              >
                <p>
                  <strong>{item.partName}</strong>
                </p>

                <p>物料编码：{item.partCode}</p>
                <p>数量：{item.quantity}</p>
                <p>归还师傅：{item.technician}</p>
                <p>确认时间：{item.confirmedAt || "-"}</p>
                <p>状态：{item.status}</p>
              </div>
            ))
        )}

      </div>


      {message && (
        <div className="card">
          <p>{message}</p>
        </div>
      )}

    </div>
  )
}


export default Warehouse