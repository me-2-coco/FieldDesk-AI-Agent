import { useState } from "react"


function Inventory() {

  const [partCode, setPartCode] = useState("")
  const [quantity, setQuantity] = useState(1)
  const [partInfo, setPartInfo] = useState(null)
  const [message, setMessage] = useState("")


  const inventoryData = [
    {
      code: "BAT-001",
      name: "电池包",
      technicianStock: 5,
      companyStock: 48
    },
    {
      code: "MB-001",
      name: "主板",
      technicianStock: 2,
      companyStock: 16
    },
    {
      code: "MOTOR-001",
      name: "驱动电机",
      technicianStock: 0,
      companyStock: 9
    }
  ]


  function searchPart() {

    const code = partCode.trim().toUpperCase()

    const foundPart = inventoryData.find(
      (item) => item.code === code
    )

    if (!foundPart) {
      setPartInfo(null)
      setMessage("未找到该物料编码")
      return
    }

    setPartInfo(foundPart)
    setMessage("")
  }


  function applyPart() {

    if (!partInfo) {
      setMessage("请先查询物料")
      return
    }

    if (quantity <= 0) {
      setMessage("申请数量必须大于 0")
      return
    }

    if (partInfo.technicianStock <= 0) {
      setMessage("你的个人库存为 0，不能申请使用")
      return
    }

    if (quantity > partInfo.technicianStock) {
      setMessage(
        `库存不足，当前最多可申请 ${partInfo.technicianStock} 个`
      )
      return
    }

    const partRequest = {
      id: Date.now(),
      technician: "张师傅",
      repairSn: "FD20260715001",
      partCode: partInfo.code,
      partName: partInfo.name,
      quantity: Number(quantity),
      status: "已申请",
      createdAt: new Date().toLocaleString()
    }

    const oldRequests = JSON.parse(
      localStorage.getItem("partRequests") || "[]"
    )

    localStorage.setItem(
      "partRequests",
      JSON.stringify([
        ...oldRequests,
        partRequest
      ])
    )

    setMessage(
      `申请成功：${partInfo.name} × ${quantity}，已绑定当前维修机器`
    )
  }


  return (

    <div className="page">

      <h1>我的库存</h1>


      <div className="card">

        <h2>当前维修机器</h2>

        <p>产品：扫地机器人 X1</p>

        <p>SN：FD20260715001</p>

        <p>维修师傅：张师傅</p>

      </div>


      <div className="card">

        <h2>查询配件</h2>

        <input
          value={partCode}
          onChange={(event) => setPartCode(event.target.value)}
          placeholder="输入物料编码，例如 BAT-001"
        />

        <button onClick={searchPart}>
          查询库存
        </button>

      </div>


      {partInfo && (

        <div className="card">

          <h2>配件信息</h2>

          <p>物料编码：{partInfo.code}</p>

          <p>配件名称：{partInfo.name}</p>

          <p>我的库存：{partInfo.technicianStock}</p>

          <p>公司总库存：{partInfo.companyStock}</p>

          <input
            type="number"
            min="1"
            value={quantity}
            onChange={(event) => setQuantity(Number(event.target.value))}
            placeholder="申请数量"
          />

          <button
            className="green"
            onClick={applyPart}
            disabled={partInfo.technicianStock <= 0}
          >
            申请配件
          </button>

        </div>

      )}


      {message && (

        <div className="card">

          <p>{message}</p>

        </div>

      )}


      <div className="card">

        <h2>我的常用库存</h2>

        {inventoryData.map((item) => (

          <div
            className="inventory-item"
            key={item.code}
          >

            <p>
              <strong>{item.name}</strong>
            </p>

            <p>编码：{item.code}</p>

            <p>个人库存：{item.technicianStock}</p>

          </div>

        ))}

      </div>

    </div>

  )
}


export default Inventory