// ==============================
// 维修工单状态统一定义
// ==============================

export const REPAIR_STATUS = {
  WAIT_RECEIPT: "待签收",
  WAIT_INSPECTION: "待检测",
  INSPECTION_COMPLETE: "检测完成/待维修",
  WAIT_REPAIR: "待维修",
  REPAIRING: "维修中",
  PAUSED: "暂停维修",
  WAIT_PARTS: "等待配件",
  WAIT_CONFIRM: "待维修确认",
  REPAIR_COMPLETED_PENDING_SHIPMENT: "维修完成/待发货",
  SHIPPED_PENDING_COMPLETION: "已发货/待完结",
  COMPLETED: "已完成"
}


export const REPAIR_STATUS_LIST = Object.values(
  REPAIR_STATUS
)


export const REPAIR_STATUS_ORDER = [
  REPAIR_STATUS.WAIT_RECEIPT,
  REPAIR_STATUS.WAIT_INSPECTION,
  REPAIR_STATUS.INSPECTION_COMPLETE,
  REPAIR_STATUS.WAIT_REPAIR,
  REPAIR_STATUS.REPAIRING,
  REPAIR_STATUS.PAUSED,
  REPAIR_STATUS.WAIT_PARTS,
  REPAIR_STATUS.WAIT_CONFIRM,
  REPAIR_STATUS.REPAIR_COMPLETED_PENDING_SHIPMENT,
  REPAIR_STATUS.SHIPPED_PENDING_COMPLETION,
  REPAIR_STATUS.COMPLETED
]


// ==============================
// 基础工具方法
// ==============================

function cloneData(data) {

  return JSON.parse(
    JSON.stringify(data)
  )

}


function createId(prefix = "REPAIR") {

  return `${prefix}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`

}


function getNowText() {

  return new Date().toLocaleString()

}


function readJson(
  storageKey,
  fallbackValue
) {

  const savedValue =
    localStorage.getItem(storageKey)


  if (!savedValue) {

    return cloneData(fallbackValue)

  }


  try {

    return JSON.parse(savedValue)

  } catch (error) {

    console.error(
      `${storageKey} 数据读取失败：`,
      error
    )

    return cloneData(fallbackValue)

  }

}


function writeJson(
  storageKey,
  value
) {

  localStorage.setItem(
    storageKey,
    JSON.stringify(value)
  )

}


// ==============================
// 默认演示工单
// ==============================

function createDefaultOrder({
  id,
  crmOrderNo = "",
  logisticsNo = "",
  customer,
  phone,
  address = "",
  product,
  model = "",
  sn,
  projectCode = "",
  manufactureDate = "",
  warrantyType = "",
  originalFault,
  technician,
  status,
  statusHistory = []
}) {

  const now = getNowText()


  return {

    // 工单基础信息
    id,

    crmOrderNo,

    logisticsNo,

    customer,

    phone,

    address,


    // 产品信息
    product,

    model,

    sn,

    projectCode,

    manufactureDate,

    warrantyType,


    // 维修业务信息
    originalFault,

    inspectionResult: "",

    faultSystem: "",

    crmFault: "",

    level3Fault: "",

    repairSolution: "",

    solution: "",

    responsibility: "",


    // AI信息
    aiRecommendation: "",

    aiConfidence: 0,

    aiReason: "",


    // 配件与附件
    parts: [],

    usedParts: [],

    returnParts: [],

    scrapParts: [],

    photos: [],

    videos: [],

    attachments: [],


    // 人员信息
    technician,


    // CRM同步信息
    crmSyncStatus: "未同步",

    crmSyncedAt: "",

    crmSyncMessage: "",


    // 状态信息
    status,

    statusUpdatedAt: now,

    createdAt: now,

    completedAt: "",

    statusHistory:
      statusHistory.length > 0
        ? statusHistory
        : [
            {
              status,
              changedAt: now,
              reason: "系统创建维修工单"
            }
          ]

  }

}


const DEFAULT_ORDERS = [

  createDefaultOrder({

    id: "REPAIR-001",

    crmOrderNo: "CRM-20260715001",

    logisticsNo: "SF1234567890",

    customer: "张三",

    phone: "13888888888",

    address: "上海市浦东新区",

    product: "扫地机器人 X1",

    model: "X1",

    sn: "FD20260715001",

    projectCode: "FD2026",

    manufactureDate: "2026-07",

    warrantyType: "保内",

    originalFault: "无法开机",

    technician: "张师傅",

    status: REPAIR_STATUS.WAIT_RECEIPT

  }),


  createDefaultOrder({

    id: "REPAIR-002",

    crmOrderNo: "CRM-20260715002",

    logisticsNo: "YT9876543210",

    customer: "李女士",

    phone: "13966668888",

    address: "江苏省苏州市",

    product: "洗地机器人 H1",

    model: "H1",

    sn: "WD20260715002",

    projectCode: "WD2026",

    manufactureDate: "2026-07",

    warrantyType: "待确认",

    originalFault: "无法充电",

    technician: "张师傅",

    status: REPAIR_STATUS.PAUSED,

    statusHistory: [

      {
        status: REPAIR_STATUS.WAIT_RECEIPT,
        changedAt: getNowText(),
        reason: "系统创建寄修任务"
      },

      {
        status: REPAIR_STATUS.WAIT_REPAIR,
        changedAt: getNowText(),
        reason: "机器已完成签收"
      },

      {
        status: REPAIR_STATUS.REPAIRING,
        changedAt: getNowText(),
        reason: "师傅开始维修"
      },

      {
        status: REPAIR_STATUS.PAUSED,
        changedAt: getNowText(),
        reason: "师傅暂时退出当前维修"
      }

    ]

  })

]


// ==============================
// 数据初始化和兼容旧数据
// ==============================

function normalizeOrder(order) {

  const now = getNowText()


  return {

    id:
      order.id ||
      createId(),

    crmOrderNo:
      order.crmOrderNo || "",

    logisticsNo:
      order.logisticsNo || "",

    customer:
      order.customer || "",

    phone:
      order.phone || "",

    address:
      order.address || "",

    product:
      order.product || "",

    model:
      order.model ||
      order.product ||
      "",

    sn:
      order.sn || "",

    projectCode:
      order.projectCode || "",

    manufactureDate:
      order.manufactureDate || "",

    warrantyType:
      order.warrantyType || "",

    originalFault:
      order.originalFault || "",

    inspectionResult:
      order.inspectionResult || "",

    inspectionRemark:
      order.inspectionRemark || "",

    specialty:
      order.specialty || "",

    receiptRemark:
      order.receiptRemark || "",

    faultSystem:
      order.faultSystem || "",

    crmFault:
      order.crmFault ||
      order.level3Fault ||
      "",

    level3Fault:
      order.level3Fault ||
      order.crmFault ||
      "",

    repairSolution:
      order.repairSolution ||
      order.solution ||
      "",

    solution:
      order.solution ||
      order.repairSolution ||
      "",

    responsibility:
      order.responsibility || "",

    aiRecommendation:
      order.aiRecommendation || "",

    aiConfidence:
      Number(order.aiConfidence) || 0,

    aiReason:
      order.aiReason || "",

    parts:
      Array.isArray(order.parts)
        ? order.parts
        : [],

    usedParts:
      Array.isArray(order.usedParts)
        ? order.usedParts
        : [],

    returnParts:
      Array.isArray(order.returnParts)
        ? order.returnParts
        : [],

    scrapParts:
      Array.isArray(order.scrapParts)
        ? order.scrapParts
        : [],

    photos:
      Array.isArray(order.photos)
        ? order.photos
        : [],

    videos:
      Array.isArray(order.videos)
        ? order.videos
        : [],

    attachments:
      Array.isArray(order.attachments)
        ? order.attachments
        : [],

    technician:
      order.technician || "",

    crmSyncStatus:
      order.crmSyncStatus || "未同步",

    crmSyncedAt:
      order.crmSyncedAt || "",

    crmSyncMessage:
      order.crmSyncMessage || "",

    status:
      REPAIR_STATUS_LIST.includes(order.status)
        ? order.status
        : REPAIR_STATUS.WAIT_RECEIPT,

    statusUpdatedAt:
      order.statusUpdatedAt || now,

    createdAt:
      order.createdAt || now,

    completedAt:
      order.completedAt || "",

    statusHistory:
      Array.isArray(order.statusHistory)
        ? order.statusHistory
        : [
            {
              status:
                order.status ||
                REPAIR_STATUS.WAIT_RECEIPT,

              changedAt:
                order.statusUpdatedAt || now,

              reason:
                "从旧版维修工单数据迁移"
            }
          ]

  }

}


function initializeRepairOrders() {

  const existingOrders =
    localStorage.getItem("repairOrders")


  if (!existingOrders) {

    writeJson(
      "repairOrders",
      DEFAULT_ORDERS
    )

  } else {

    const savedOrders = readJson(
      "repairOrders",
      DEFAULT_ORDERS
    )

    const normalizedOrders =
      Array.isArray(savedOrders)
        ? savedOrders.map(normalizeOrder)
        : cloneData(DEFAULT_ORDERS)

    writeJson(
      "repairOrders",
      normalizedOrders
    )

  }


  const existingCurrentOrderId =
    localStorage.getItem(
      "currentRepairOrderId"
    )


  if (!existingCurrentOrderId) {

    localStorage.setItem(
      "currentRepairOrderId",
      DEFAULT_ORDERS[0].id
    )

  }


  // 兼容旧版单个工单
  const oldCurrentOrder =
    localStorage.getItem(
      "currentRepairOrder"
    )


  if (oldCurrentOrder) {

    try {

      const parsedOldOrder =
        normalizeOrder(
          JSON.parse(oldCurrentOrder)
        )


      const orders =
        readJson(
          "repairOrders",
          DEFAULT_ORDERS
        )


      const oldOrderExists =
        orders.some(
          (item) =>
            item.id === parsedOldOrder.id
        )


      if (!oldOrderExists) {

        writeJson(
          "repairOrders",
          [
            ...orders,
            parsedOldOrder
          ]
        )

      }


      localStorage.setItem(
        "currentRepairOrderId",
        parsedOldOrder.id
      )

    } catch (error) {

      console.error(
        "旧版维修工单迁移失败：",
        error
      )

    }

  }

}


// ==============================
// 工单查询和保存
// ==============================

export function getRepairOrders() {

  initializeRepairOrders()


  const orders = readJson(
    "repairOrders",
    DEFAULT_ORDERS
  )


  return Array.isArray(orders)
    ? orders.map(normalizeOrder)
    : cloneData(DEFAULT_ORDERS)

}


export function saveRepairOrders(orders) {

  if (!Array.isArray(orders)) {

    console.error(
      "保存维修工单失败：orders 必须是数组"
    )

    return

  }


  writeJson(
    "repairOrders",
    orders.map(normalizeOrder)
  )

}


export function getCurrentRepairOrderId() {

  initializeRepairOrders()


  return localStorage.getItem(
    "currentRepairOrderId"
  )

}


export function setCurrentRepairOrderId(orderId) {

  const orders =
    getRepairOrders()


  const orderExists =
    orders.some(
      (item) =>
        item.id === orderId
    )


  if (!orderExists) {

    console.error(
      `没有找到维修工单：${orderId}`
    )

    return null

  }


  localStorage.setItem(
    "currentRepairOrderId",
    orderId
  )


  return getRepairOrderById(orderId)

}


export function getRepairOrderById(orderId) {

  const orders =
    getRepairOrders()


  return (
    orders.find(
      (item) =>
        item.id === orderId
    ) || null
  )

}


export function getCurrentRepairOrder() {

  initializeRepairOrders()


  const currentOrderId =
    localStorage.getItem(
      "currentRepairOrderId"
    )


  let currentOrder =
    getRepairOrderById(
      currentOrderId
    )


  if (!currentOrder) {

    currentOrder =
      getRepairOrders()[0] || null

  }


  if (!currentOrder) {

    currentOrder =
      createRepairOrder()

  }


  localStorage.setItem(
    "currentRepairOrderId",
    currentOrder.id
  )


  writeJson(
    "currentRepairOrder",
    currentOrder
  )


  return currentOrder

}


// ==============================
// 创建新工单
// ==============================

export function createRepairOrder(
  fields = {}
) {

  const now =
    getNowText()


  const initialStatus =
    REPAIR_STATUS_LIST.includes(
      fields.status
    )
      ? fields.status
      : REPAIR_STATUS.WAIT_RECEIPT


  const newOrder = {

    // 工单基本信息
    id:
      fields.id ||
      createId(),

    crmOrderNo:
      fields.crmOrderNo || "",

    logisticsNo:
      fields.logisticsNo || "",

    customer:
      fields.customer || "",

    phone:
      fields.phone || "",

    address:
      fields.address || "",


    // 产品与SN信息
    product:
      fields.product || "",

    model:
      fields.model || "",

    sn:
      fields.sn || "",

    projectCode:
      fields.projectCode || "",

    manufactureDate:
      fields.manufactureDate || "",

    warrantyType:
      fields.warrantyType || "",


    // 维修信息
    originalFault:
      fields.originalFault || "",

    inspectionResult:
      fields.inspectionResult || "",

    inspectionRemark:
      fields.inspectionRemark || "",

    specialty:
      fields.specialty || "",

    receiptRemark:
      fields.receiptRemark || "",

    faultSystem:
      fields.faultSystem || "",

    crmFault:
      fields.crmFault ||
      fields.level3Fault ||
      "",

    level3Fault:
      fields.level3Fault ||
      fields.crmFault ||
      "",

    repairSolution:
      fields.repairSolution ||
      fields.solution ||
      "",

    solution:
      fields.solution ||
      fields.repairSolution ||
      "",

    responsibility:
      fields.responsibility || "",


    // AI信息
    aiRecommendation:
      fields.aiRecommendation || "",

    aiConfidence:
      Number(fields.aiConfidence) || 0,

    aiReason:
      fields.aiReason || "",


    // 配件信息
    parts:
      Array.isArray(fields.parts)
        ? fields.parts
        : [],

    usedParts:
      Array.isArray(fields.usedParts)
        ? fields.usedParts
        : [],

    returnParts:
      Array.isArray(fields.returnParts)
        ? fields.returnParts
        : [],

    scrapParts:
      Array.isArray(fields.scrapParts)
        ? fields.scrapParts
        : [],


    // 附件信息
    photos:
      Array.isArray(fields.photos)
        ? fields.photos
        : [],

    videos:
      Array.isArray(fields.videos)
        ? fields.videos
        : [],

    attachments:
      Array.isArray(fields.attachments)
        ? fields.attachments
        : [],


    // 人员
    technician:
      fields.technician || "",


    // CRM同步信息
    crmSyncStatus:
      fields.crmSyncStatus || "未同步",

    crmSyncedAt:
      fields.crmSyncedAt || "",

    crmSyncMessage:
      fields.crmSyncMessage || "",


    // 状态信息
    status:
      initialStatus,

    statusUpdatedAt:
      now,

    createdAt:
      fields.createdAt || now,

    completedAt:
      fields.completedAt || "",

    statusHistory: [
      {
        status:
          initialStatus,

        changedAt:
          now,

        reason:
          fields.statusReason ||
          "系统创建维修工单"
      }
    ]

  }


  const orders =
    getRepairOrders()


  saveRepairOrders([
    ...orders,
    newOrder
  ])


  localStorage.setItem(
    "currentRepairOrderId",
    newOrder.id
  )


  writeJson(
    "currentRepairOrder",
    newOrder
  )


  return newOrder

}


// ==============================
// 更新和保存当前工单
// ==============================

export function saveCurrentRepairOrder(
  order
) {

  if (!order?.id) {

    console.error(
      "保存维修工单失败：缺少工单 ID"
    )

    return null

  }


  const normalizedOrder =
    normalizeOrder(order)


  const orders =
    getRepairOrders()


  const orderExists =
    orders.some(
      (item) =>
        item.id === normalizedOrder.id
    )


  const updatedOrders =
    orderExists
      ? orders.map((item) =>
          item.id === normalizedOrder.id
            ? normalizedOrder
            : item
        )
      : [
          ...orders,
          normalizedOrder
        ]


  saveRepairOrders(
    updatedOrders
  )


  localStorage.setItem(
    "currentRepairOrderId",
    normalizedOrder.id
  )


  writeJson(
    "currentRepairOrder",
    normalizedOrder
  )


  return normalizedOrder

}


export function updateRepairOrder(
  fields
) {

  const currentOrder =
    getCurrentRepairOrder()


  const now =
    getNowText()


  const statusChanged =
    fields.status &&
    fields.status !== currentOrder.status


  const updatedHistory =
    statusChanged
      ? [
          ...(currentOrder.statusHistory || []),

          {
            status:
              fields.status,

            changedAt:
              now,

            reason:
              fields.statusReason ||
              getDefaultStatusReason(
                fields.status
              )
          }
        ]
      : currentOrder.statusHistory || []


  const updatedOrder = {

    ...currentOrder,

    ...fields,

    crmFault:
      fields.crmFault ??
      fields.level3Fault ??
      currentOrder.crmFault,

    level3Fault:
      fields.level3Fault ??
      fields.crmFault ??
      currentOrder.level3Fault,

    repairSolution:
      fields.repairSolution ??
      fields.solution ??
      currentOrder.repairSolution,

    solution:
      fields.solution ??
      fields.repairSolution ??
      currentOrder.solution,

    statusUpdatedAt:
      statusChanged
        ? now
        : currentOrder.statusUpdatedAt,

    statusHistory:
      updatedHistory

  }


  if (
    fields.status ===
      REPAIR_STATUS.COMPLETED &&
    !updatedOrder.completedAt
  ) {

    updatedOrder.completedAt =
      now

  }


  return saveCurrentRepairOrder(
    updatedOrder
  )

}


export function updateRepairStatus(
  status,
  reason = ""
) {

  if (
    !REPAIR_STATUS_LIST.includes(
      status
    )
  ) {

    console.error(
      `不允许使用的维修状态：${status}`
    )

    return getCurrentRepairOrder()

  }


  return updateRepairOrder({

    status,

    statusReason:
      reason ||
      getDefaultStatusReason(status)

  })

}


// ==============================
// 根据操作自动改变状态
// ==============================

export function updateStatusByAction(
  action
) {

  const actionStatusMap = {

    RECEIVE_MACHINE: {

      status:
        REPAIR_STATUS.WAIT_REPAIR,

      reason:
        "机器签收完成"

    },


    START_REPAIR: {

      status:
        REPAIR_STATUS.REPAIRING,

      reason:
        "师傅开始维修"

    },


    CONTINUE_REPAIR: {

      status:
        REPAIR_STATUS.REPAIRING,

      reason:
        "师傅继续维修"

    },


    PAUSE_REPAIR: {

      status:
        REPAIR_STATUS.PAUSED,

      reason:
        "师傅暂时退出当前维修"

    },


    WAIT_FOR_PARTS: {

      status:
        REPAIR_STATUS.WAIT_PARTS,

      reason:
        "维修所需配件库存不足"

    },


    PARTS_READY: {

      status:
        REPAIR_STATUS.REPAIRING,

      reason:
        "维修配件已经准备完成"

    },


    FINISH_REPAIR: {

      status:
        REPAIR_STATUS.WAIT_CONFIRM,

      reason:
        "维修操作完成，等待结果确认"

    },


    CONFIRM_COMPLETION: {

      status:
        REPAIR_STATUS.COMPLETED,

      reason:
        "维修结果已经提交完成"

    }

  }


  const statusConfig =
    actionStatusMap[action]


  if (!statusConfig) {

    console.error(
      `没有找到状态操作：${action}`
    )

    return getCurrentRepairOrder()

  }


  return updateRepairStatus(
    statusConfig.status,
    statusConfig.reason
  )

}


// ==============================
// 状态文字和样式
// ==============================

export function getDefaultStatusReason(
  status
) {

  const reasonMap = {

    [REPAIR_STATUS.WAIT_RECEIPT]:
      "等待维修网点确认签收",

    [REPAIR_STATUS.WAIT_REPAIR]:
      "机器已经签收，等待师傅开始维修",

    [REPAIR_STATUS.REPAIRING]:
      "师傅正在维修机器",

    [REPAIR_STATUS.PAUSED]:
      "当前维修已暂时停止",

    [REPAIR_STATUS.WAIT_PARTS]:
      "维修正在等待所需配件",

    [REPAIR_STATUS.WAIT_CONFIRM]:
      "维修完成，等待提交维修结果",

    [REPAIR_STATUS.COMPLETED]:
      "维修流程已全部完成"

  }


  return (
    reasonMap[status] ||
    "系统自动更新维修状态"
  )

}


export function getRepairActionText(
  status
) {

  const actionTextMap = {

    [REPAIR_STATUS.WAIT_RECEIPT]:
      "确认签收",

    [REPAIR_STATUS.WAIT_REPAIR]:
      "开始维修",

    [REPAIR_STATUS.REPAIRING]:
      "进入维修",

    [REPAIR_STATUS.PAUSED]:
      "继续维修",

    [REPAIR_STATUS.WAIT_PARTS]:
      "查看维修进度",

    [REPAIR_STATUS.WAIT_CONFIRM]:
      "进入维修完成确认",

    [REPAIR_STATUS.COMPLETED]:
      "查看维修记录"

  }


  return (
    actionTextMap[status] ||
    "查看维修任务"
  )

}


export function getRepairStatusClassName(
  status
) {

  const statusClassMap = {

    [REPAIR_STATUS.WAIT_RECEIPT]:
      "status-waiting",

    [REPAIR_STATUS.WAIT_REPAIR]:
      "status-waiting",

    [REPAIR_STATUS.REPAIRING]:
      "status-working",

    [REPAIR_STATUS.PAUSED]:
      "status-paused",

    [REPAIR_STATUS.WAIT_PARTS]:
      "status-parts",

    [REPAIR_STATUS.WAIT_CONFIRM]:
      "status-confirm",

    [REPAIR_STATUS.COMPLETED]:
      "status-completed"

  }


  return (
    statusClassMap[status] ||
    "status-default"
  )

}


// ==============================
// 工单筛选
// ==============================

export function getRepairOrdersByStatus(
  status
) {

  return getRepairOrders().filter(
    (item) =>
      item.status === status
  )

}


export function getTechnicianRepairOrders(
  technician
) {

  return getRepairOrders().filter(
    (item) =>
      item.technician === technician
  )

}


export function getActiveRepairOrders() {

  return getRepairOrders().filter(
    (item) =>
      item.status !==
      REPAIR_STATUS.COMPLETED
  )

}


export function getCompletedRepairOrders() {

  return getRepairOrders().filter(
    (item) =>
      item.status ===
      REPAIR_STATUS.COMPLETED
  )

}


// ==============================
// CRM查询辅助
// ==============================

export function findRepairOrderByLogisticsNo(
  logisticsNo
) {

  const searchText =
    String(logisticsNo || "")
      .trim()
      .toLowerCase()


  if (!searchText) {
    return null
  }


  return (
    getRepairOrders().find(
      (order) =>
        String(order.logisticsNo || "")
          .trim()
          .toLowerCase() === searchText
    ) || null
  )

}


export function findRepairOrderByCrmOrderNo(
  crmOrderNo
) {

  const searchText =
    String(crmOrderNo || "")
      .trim()
      .toLowerCase()


  if (!searchText) {
    return null
  }


  return (
    getRepairOrders().find(
      (order) =>
        String(order.crmOrderNo || "")
          .trim()
          .toLowerCase() === searchText
    ) || null
  )

}


export function searchRepairOrders(
  keyword
) {

  const searchText =
    String(keyword || "")
      .trim()
      .toLowerCase()


  if (!searchText) {
    return getRepairOrders()
  }


  return getRepairOrders().filter(
    (order) => {

      const searchableText = [

        order.id,

        order.crmOrderNo,

        order.logisticsNo,

        order.customer,

        order.phone,

        order.address,

        order.product,

        order.model,

        order.sn,

        order.originalFault,

        order.technician,

        order.status

      ]
        .map((value) =>
          String(value || "")
            .toLowerCase()
        )
        .join(" ")


      return searchableText.includes(
        searchText
      )

    }
  )

}


// ==============================
// 重置演示数据
// ==============================

export function resetRepairOrders() {

  writeJson(
    "repairOrders",
    DEFAULT_ORDERS
  )


  localStorage.setItem(
    "currentRepairOrderId",
    DEFAULT_ORDERS[0].id
  )


  writeJson(
    "currentRepairOrder",
    DEFAULT_ORDERS[0]
  )


  return cloneData(
    DEFAULT_ORDERS
  )

}
