function warrantyClass(value) {
  const text = String(value || "").trim()
  if (text.includes("保外")) return "warranty-badge warranty-badge-out"
  if (text.includes("保内")) return "warranty-badge warranty-badge-in"
  return "warranty-badge warranty-badge-pending"
}

function WarrantyBadge({ value, fallback = "待确认" }) {
  return <span className={warrantyClass(value)}>{value || fallback}</span>
}

export default WarrantyBadge
