import { getCurrentRepairOrder, REPAIR_STATUS } from "../shared/repairOrderStore.js"
import { USER_ROLES } from "../shared/userStore.js"
import SupervisionInbox from "../components/SupervisionInbox.jsx"

function nextPageForStatus(status) {
  if (status === REPAIR_STATUS.WAIT_INSPECTION) return "partsApplication"
  if (status === REPAIR_STATUS.INSPECTION_COMPLETE) return "repairCompletion"
  if (status === REPAIR_STATUS.WAIT_PARTS) return "inventory"
  if ([
    REPAIR_STATUS.WAIT_REPAIR,
    REPAIR_STATUS.REPAIRING,
    REPAIR_STATUS.PAUSED
  ].includes(status)) return "repairWork"
  if (status === REPAIR_STATUS.WAIT_CONFIRM) return "repairProcess"
  if (status === REPAIR_STATUS.REPAIR_COMPLETED_PENDING_SHIPMENT || status === REPAIR_STATUS.SHIPPED_PENDING_COMPLETION) return "returnShipping"
  return "repair"
}

function Home({ setPage, currentUser, supervisionOpenKey = 0, supervisionTargetRmaNo = "" }) {
  const order = getCurrentRepairOrder()
  const isTechnician = currentUser?.role === USER_ROLES.TECHNICIAN
  const isWarehouse = currentUser?.role === USER_ROLES.WAREHOUSE
  const isAdmin = currentUser?.role === USER_ROLES.ADMIN
  const nextPage = nextPageForStatus(order?.status)

  return <div className="page home-page">
    <div className="card">
      <h1>FieldDesk 工作台</h1>
      <p>当前账号：{currentUser?.name || "未识别"}</p>
      <p>角色：{isAdmin ? "管理员" : isWarehouse ? "库房" : "维修师傅"}</p>
      {isTechnician && <p>维修品类：{currentUser.repairSpecialties?.join(" / ") || "未配置"}</p>}
    </div>

    {(isTechnician || isAdmin) && <SupervisionInbox openKey={supervisionOpenKey} targetRmaNo={supervisionTargetRmaNo} />}

    {(isTechnician || isAdmin) && <div className="card">
      <h2>维修执行</h2>
      <button className="primary-btn" onClick={() => setPage("repair")}>到店查询与签收准备</button>
      {order?.crmOrderNo && <>
        <p>当前工单：{order.crmOrderNo}</p>
        <p>当前状态：{order.status || "未提供"}</p>
        <button className="primary-btn" onClick={() => setPage(nextPage)}>继续当前工单</button>
      </>}
    </div>}

    {isTechnician && <div className="card">
      <h2>个人库存</h2>
      <button className="primary-btn" onClick={() => setPage("inventory")}>查看个人库存与配件流水</button>
    </div>}

    {(isWarehouse || isAdmin) && <div className="card">
      <h2>库房与发货</h2>
      <button className="primary-btn" onClick={() => setPage("warehouse")}>库房退还确认</button>
      <button className="primary-btn" onClick={() => setPage("inventory")}>查看总库与师傅库存</button>
      <button className="primary-btn" onClick={() => setPage("returnShipping")}>待发货与待完结工单</button>
    </div>}

    {isAdmin && <div className="card">
      <h2>管理</h2>
      <button className="primary-btn" onClick={() => setPage("profile")}>账号、同步与系统管理</button>
    </div>}

    <p className="dry-run-notice">当前保持演练模式，本地业务操作不会写入瑞云。</p>
  </div>
}

export default Home
