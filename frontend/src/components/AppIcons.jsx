export function CameraIcon({ size = 20 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M8.2 6.5 9.4 4.8h5.2l1.2 1.7h2.7A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5V9a2.5 2.5 0 0 1 2.5-2.5h2.7Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
    <circle cx="12" cy="13" r="3.6" stroke="currentColor" strokeWidth="1.8"/>
  </svg>
}

export function ScanIcon({ size = 21 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M8 4H5a1 1 0 0 0-1 1v3M16 4h3a1 1 0 0 1 1 1v3M8 20H5a1 1 0 0 1-1-1v-3M16 20h3a1 1 0 0 0 1-1v-3M7 12h10" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"/>
  </svg>
}

const ICON_PATHS = {
  home: <><path d="M3.5 10.5 12 3.8l8.5 6.7"/><path d="M5.5 9.8v10h13v-10M9.5 19.8v-6h5v6"/></>,
  work: <><rect x="4" y="5.5" width="16" height="14" rx="3"/><path d="M8 5.5V4h8v1.5M4 11h16M9 14h6"/></>,
  records: <><path d="M6 3.8h9l3 3v13.4H6z"/><path d="M15 3.8v3h3M9 11h6M9 15h6"/></>,
  inventory: <><path d="m4 7 8-4 8 4-8 4zM4 7v10l8 4 8-4V7M12 11v10"/></>,
  warehouse: <><path d="m3 9 9-5 9 5v11H3zM7 20v-7h10v7M8 9h.01M12 9h.01M16 9h.01"/></>,
  shipping: <><path d="M3 6h11v11H3zM14 10h4l3 3v4h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></>,
  archive: <><path d="M5 4h14v4H5zM6 8v12h12V8M9 12h6"/></>,
  profile: <><circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/></>,
  recovery: <><path d="M5 8V4m0 0h4M5 4l4 4"/><path d="M6.3 16.7A8 8 0 1 0 5 8"/></>,
  alert: <><path d="M12 3 2.8 20h18.4z"/><path d="M12 9v5M12 17.5h.01"/></>,
  tracking: <><path d="M12 21s6-5.3 6-11a6 6 0 1 0-12 0c0 5.7 6 11 6 11Z"/><circle cx="12" cy="10" r="2"/></>,
  sync: <><path d="M20 7h-5V2M4 17h5v5"/><path d="M18.5 11A7 7 0 0 0 6 6L4 8M5.5 13A7 7 0 0 0 18 18l2-2"/></>,
  diagnostic: <><path d="M4 12h3l2-5 4 10 2-5h5"/><rect x="3" y="3" width="18" height="18" rx="4"/></>,
  accounts: <><circle cx="9" cy="8" r="3"/><path d="M3.5 18a5.5 5.5 0 0 1 11 0M16 8h5M18.5 5.5v5"/></>,
  history: <><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2M4 5v4h4"/></>
}

export function AppIcon({ name, size = 20 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {ICON_PATHS[name] || ICON_PATHS.work}
  </svg>
}
