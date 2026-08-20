import {
  getCurrentUser,
  getNavigationItems
} from "../shared/userStore.js"


function BottomNav({
  page,
  setPage,
  supervisionUnreadCount = 0
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
              : ""
          }
          onClick={() =>
            setPage(item.page)
          }
        >
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
