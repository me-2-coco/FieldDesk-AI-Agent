export const USER_ROLES = {
  TECHNICIAN: "technician",
  WAREHOUSE: "warehouse",
  INFORMATION_CLERK: "information_clerk",
  ADMIN: "admin"
}


export const USER_ROLE_NAMES = {
  technician: "师傅",
  warehouse: "库房",
  information_clerk: "信息员",
  admin: "管理员"
}


const DEFAULT_USERS = [
  {
    id: "USER-006",
    name: "信息员",
    account: "info",
    role: USER_ROLES.INFORMATION_CLERK,
    repairSpecialties: []
  },
  {
    id: "USER-001",
    name: "张师傅",
    account: "zhang",
    role: USER_ROLES.TECHNICIAN,
    repairSpecialties: ["扫地机"]
  },
  {
    id: "USER-002",
    name: "王库管",
    account: "wang",
    role: USER_ROLES.WAREHOUSE,
    repairSpecialties: []
  },
  {
    id: "USER-003",
    name: "系统管理员",
    account: "admin",
    role: USER_ROLES.ADMIN,
    repairSpecialties: ["扫地机", "洗地机"]
  },
  {
    id: "USER-004",
    name: "李师傅",
    account: "li",
    role: USER_ROLES.TECHNICIAN,
    repairSpecialties: ["洗地机"]
  },
  {
    id: "USER-005",
    name: "赵师傅",
    account: "zhao",
    role: USER_ROLES.TECHNICIAN,
    repairSpecialties: ["扫地机", "洗地机"]
  }
]


const DEFAULT_CURRENT_USER_ID = "USER-001"
let authenticatedUser = null


function cloneData(data) {
  return JSON.parse(
    JSON.stringify(data)
  )
}


function readJson(storageKey, fallbackValue) {

  const savedValue = localStorage.getItem(storageKey)

  if (!savedValue) {
    return cloneData(fallbackValue)
  }

  try {
    return JSON.parse(savedValue)
  } catch (error) {
    console.error(`${storageKey} 数据读取失败：`, error)

    return cloneData(fallbackValue)
  }
}


function writeJson(storageKey, value) {

  localStorage.setItem(
    storageKey,
    JSON.stringify(value)
  )
}


function initializeUsers() {

  if (!localStorage.getItem("fieldDeskUsers")) {

    writeJson(
      "fieldDeskUsers",
      DEFAULT_USERS
    )
  } else {
    try {
      const storedUsers = JSON.parse(localStorage.getItem("fieldDeskUsers"))
      const missingUsers = DEFAULT_USERS.filter((candidate) =>
        !storedUsers.some((user) => user.id === candidate.id)
      )
      if (missingUsers.length) writeJson("fieldDeskUsers", [...storedUsers, ...missingUsers])
    } catch {
      writeJson("fieldDeskUsers", DEFAULT_USERS)
    }
  }

  if (!localStorage.getItem("currentUserId")) {

    localStorage.setItem(
      "currentUserId",
      DEFAULT_CURRENT_USER_ID
    )
  }
}


export function getUsers() {

  initializeUsers()

  return readJson(
    "fieldDeskUsers",
    DEFAULT_USERS
  )
}


export function getCurrentUserId() {

  initializeUsers()

  return localStorage.getItem("currentUserId")
}


export function getCurrentUser() {

  if (authenticatedUser) return authenticatedUser

  const users = getUsers()
  const currentUserId = getCurrentUserId()

  return (
    users.find(
      (user) => user.id === currentUserId
    ) || users[0]
  )
}

export function setAuthenticatedUser(user) {
  authenticatedUser = user || null
  return authenticatedUser
}


export function setCurrentUser(userId) {

  const users = getUsers()

  const user = users.find(
    (item) => item.id === userId
  )

  if (!user) {
    console.error(`没有找到用户：${userId}`)

    return null
  }

  localStorage.setItem(
    "currentUserId",
    userId
  )

  return user
}


export function getRoleName(role) {

  return USER_ROLE_NAMES[role] || "未知角色"
}


export function isTechnician(user = getCurrentUser()) {

  return user.role === USER_ROLES.TECHNICIAN
}


export function isWarehouse(user = getCurrentUser()) {

  return user.role === USER_ROLES.WAREHOUSE
}


export function isAdmin(user = getCurrentUser()) {

  return user.role === USER_ROLES.ADMIN
}


export function canAccessPage(
  page,
  user = getCurrentUser()
) {

  const rolePermissions = {

    technician: [
    "home",
    "repair",
    "repairTask",
    "repairWork",
    "repairProcess",
    "repairDecision",
    "partsApplication",
    "repairCompletion",
    "repairFinish",
    "records",
    "inventory",
    "profile"
],

    warehouse: [
      "home",
      "inventory",
      "warehouse",
      "profile"
    ],

    information_clerk: [
      "home",
      "records",
      "returnShipping",
      "machineTracking",
      "repairReports",
      "exceptionCenter",
      "profile"
    ],

   admin: [
  "home",
  "repair",
  "repairTask",
  "repairWork",
  "repairProcess",
  "repairDecision",
  "partsApplication",
  "repairCompletion",
  "returnShipping",
  "repairFinish",
  "records",
  "inventory",
  "warehouse",
  "syncTasks",
  "syncDiagnostics",
  "accountManagement",
  "adminRepairRecovery",
  "machineTracking",
  "repairReports",
  "exceptionCenter",
  "profile"
],

  }


  const normalizedRole = String(user?.role || "").trim().toLowerCase()
  const allowedPages = rolePermissions[normalizedRole] || []


  return allowedPages.includes(page)
}


export function getNavigationItems(
  user = getCurrentUser()
) {

  const navigationByRole = {

    technician: [
      {
        page: "home",
        label: "首页"
      },
      {
        page: "repair",
        label: "工单"
      },
      {
        page: "records",
        label: "历史"
      },
      {
        page: "inventory",
        label: "库存"
      },
      {
        page: "profile",
        label: "我的"
      }
    ],

    warehouse: [
      {
        page: "home",
        label: "首页"
      },
      {
        page: "inventory",
        label: "库存"
      },
      {
        page: "warehouse",
        label: "库房"
      },
      {
        page: "profile",
        label: "我的"
      }
    ],

    information_clerk: [
      { page: "home", label: "首页" },
      { page: "machineTracking", label: "去向" },
      { page: "repairReports", label: "档案" },
      { page: "exceptionCenter", label: "问题" },
      { page: "records", label: "历史" },
      { page: "profile", label: "我的" }
    ],

    admin: [
      {
        page: "home",
        label: "首页"
      },
      {
        page: "repair",
        label: "工单"
      },
      {
        page: "records",
        label: "历史"
      },
      {
        page: "inventory",
        label: "库存"
      },
      {
        page: "warehouse",
        label: "库房"
      },
      { page: "machineTracking", label: "去向" },
      {
        page: "profile",
        label: "我的"
      }
    ]

  }


  return navigationByRole[user.role] || []
}


export function resetUsers() {

  writeJson(
    "fieldDeskUsers",
    DEFAULT_USERS
  )

  localStorage.setItem(
    "currentUserId",
    DEFAULT_CURRENT_USER_ID
  )

  return cloneData(DEFAULT_USERS)
}
