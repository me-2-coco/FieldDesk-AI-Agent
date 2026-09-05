import {
  getCurrentUser,
  getNavigationItems
} from "../shared/userStore.js"
import { AppIcon } from "./AppIcons.jsx"


function BottomNav({
  page,
  setPage,
  supervisionUnreadCount = 0,
  onOpenSupervision,
  workflowLocked = false
}) {

  const currentUser = getCurrentUser()

  const navigationItems =
    getNavigationItems(currentUser)


  return (

    <div className="bottom-nav">


      {navigationItems.map((item) => (

        <button
          type="button"
          key={item.page}
          className={
            page === item.page
              ? "active"
              : workflowLocked && ["home", "repair"].includes(item.page) ? "workflow-locked" : ""
          }
          aria-disabled={workflowLocked && ["home", "repair"].includes(item.page)}
          title={workflowLocked && ["home", "repair"].includes(item.page) ? "当前工单处理完成或暂存后才能返回" : ""}
          onClick={() => {
            if (item.page === "home" && supervisionUnreadCount > 0 && onOpenSupervision) {
              onOpenSupervision()
              return
            }
            setPage(item.page)
          }}
        >
          <span className="bottom-nav-icon"><AppIcon name={item.icon} size={20} /></span>
          <span className="bottom-nav-label">
            {item.label}
            {item.page === "home" && supervisionUnreadCount > 0 && (
              <span className="bottom-nav-badge" aria-label={`${supervisionUnreadCount}条未读督办通知`}>
                {supervisionUnreadCount > 99 ? "99+" : supervisionUnreadCount}
              </span>
            )}
          </span>
        </button>

      ))}


    </div>

  )

}


export default BottomNav
