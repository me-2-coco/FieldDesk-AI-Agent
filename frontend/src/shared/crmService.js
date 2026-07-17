import {
  createRepairOrder,
  findRepairOrderByLogisticsNo,
  setCurrentRepairOrderId
} from "./repairOrderStore.js"


const MOCK_CRM_ORDERS = [
  {
    crmOrderNo: "CRM-20260716001",
    logisticsNo: "SF202607160001",
    customer: "王先生",
    phone: "13688886666",
    address: "浙江省杭州市",
    product: "扫地机器人 X2",
    model: "X2",
    sn: "R12345067A001",
    originalFault: "机器运行时异响",
    technician: "张师傅",
    warrantyType: "待确认"
  },
  {
    crmOrderNo: "CRM-20260716002",
    logisticsNo: "YT202607160002",
    customer: "赵女士",
    phone: "13777775555",
    address: "江苏省南京市",
    product: "洗地机 W1",
    model: "W1",
    sn: "W67890056B002",
    originalFault: "无法出水",
    technician: "张师傅",
    warrantyType: "待确认"
  }
]


function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}


export async function queryCrmOrderByLogisticsNo(
  logisticsNo
) {

  const searchText = String(logisticsNo || "")
    .trim()
    .toLowerCase()


  if (!searchText) {
    throw new Error("请输入物流单号")
  }


  await wait(500)


  const existingOrder =
    findRepairOrderByLogisticsNo(searchText)


  if (existingOrder) {

    setCurrentRepairOrderId(existingOrder.id)

    return {
      source: "local",
      isNew: false,
      order: existingOrder
    }
  }


  const crmOrder = MOCK_CRM_ORDERS.find(
    (item) =>
      item.logisticsNo
        .trim()
        .toLowerCase() === searchText
  )


  if (!crmOrder) {
    throw new Error("没有查询到对应的寄修工单")
  }


  const newOrder = createRepairOrder({
    ...crmOrder,
    status: "待签收",
    statusReason: "从瑞云 CRM 查询到寄修工单"
  })


  return {
    source: "mock-crm",
    isNew: true,
    order: newOrder
  }
}