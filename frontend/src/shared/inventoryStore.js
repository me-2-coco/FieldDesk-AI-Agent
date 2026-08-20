const DEFAULT_INVENTORY = {
  totalStock: [
    {
      code: "BAT-001",
      name: "电池包",
      stock: 48
    },
    {
      code: "MB-001",
      name: "主板",
      stock: 20
    },
    {
      code: "MOTOR-001",
      name: "驱动电机",
      stock: 9
    },
    {
      code: "CHARGE-001",
      name: "充电模块",
      stock: 12
    }
  ],

  technicianStock: {
    张师傅: [
      {
        code: "BAT-001",
        name: "电池包",
        stock: 5
      },
      {
        code: "MB-001",
        name: "主板",
        stock: 2
      }
    ]
  },

  returnApply: []
}


export function getInventory() {
  const savedInventory = localStorage.getItem("inventoryStore")

  if (!savedInventory) {
    localStorage.setItem(
      "inventoryStore",
      JSON.stringify(DEFAULT_INVENTORY)
    )

    return structuredClone(DEFAULT_INVENTORY)
  }

  try {
    return JSON.parse(savedInventory)
  } catch (error) {
    console.error("库存数据读取失败：", error)

    localStorage.setItem(
      "inventoryStore",
      JSON.stringify(DEFAULT_INVENTORY)
    )

    return structuredClone(DEFAULT_INVENTORY)
  }
}


export function saveInventory(inventory) {
  localStorage.setItem(
    "inventoryStore",
    JSON.stringify(inventory)
  )
}


export function resetInventory() {
  localStorage.setItem(
    "inventoryStore",
    JSON.stringify(DEFAULT_INVENTORY)
  )

  return structuredClone(DEFAULT_INVENTORY)
}