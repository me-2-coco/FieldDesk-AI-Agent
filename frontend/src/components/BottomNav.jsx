import {
  getCurrentUser,
  getNavigationItems
} from "../shared/userStore.js"


function BottomNav({
  page,
  setPage
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
          {item.label}
        </button>

      ))}


    </div>

  )

}


export default BottomNav