import React from 'react'
import { createRoot } from 'react-dom/client'
import RepairCompletion from './src/pages/RepairCompletion.jsx'
import { createRepairOrder, REPAIR_STATUS } from './src/shared/repairOrderStore.js'
import './src/App.css'
if (!localStorage.getItem('currentRepairOrderId')) {
  createRepairOrder({ crmOrderNo: 'LAB-UI-ONLY', customer: '模拟客户',
    status: REPAIR_STATUS.REPAIRING, treatmentMode: 'DEBUGGING', originalFault: '模拟故障' })
}
createRoot(document.getElementById('root')).render(<RepairCompletion setPage={page => {
  document.body.dataset.destination = page
}} />)
