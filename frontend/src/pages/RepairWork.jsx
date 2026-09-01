import { useEffect } from "react"
import { updateStatusByAction } from "../shared/repairOrderStore.js"


// 实际维修阶段：配件、维修经过、维修完成
function RepairWork({ setPage }) {
  useEffect(() => {
    updateStatusByAction("FINISH_REPAIR")
    setPage("repairProcess")
  }, [setPage])
  return null
}

export default RepairWork
