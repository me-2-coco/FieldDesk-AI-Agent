export const USER_ROLES = {
  TECHNICIAN: "technician",
  WAREHOUSE: "warehouse",
  ADMIN: "admin"
}


export const USER_ROLE_NAMES = {
  technician: "师傅",
  warehouse: "库房",
  admin: "管理员"
}


const DEFAULT_USERS = [
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
  }
]


const DEFAULT_CURRENT_USER_ID = "USER-001"


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

  const users = getUsers()
  const currentUserId = getCurrentUserId()

  return (
    users.find(
      (user) => user.id === currentUserId
    ) || users[0]
  )
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

   admin: [
  "home",
  "repair",
  "repairTask",
  "repairWork",
  "repairProcess",
  "partsApplication",
  "repairCompletion",
  "repairFinish",
  "records",
  "inventory",
  "warehouse",
  "profile"
],

  }


  const allowedPages =
    rolePermissions[user.role] || []


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
        label: "维修"
      },
      {
        page: "records",
        label: "记录"
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

    admin: [
      {
        page: "home",
        label: "首页"
      },
      {
        page: "repair",
        label: "维修"
      },
      {
        page: "records",
        label: "记录"
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
