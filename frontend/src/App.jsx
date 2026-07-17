import { useState } from "react"

import Login from "./pages/Login.jsx"
import Home from "./pages/Home.jsx"
import Repair from "./pages/Repair.jsx"
import RepairTask from "./pages/RepairTask.jsx"
import RepairWork from "./pages/RepairWork.jsx"
import RepairFinish from "./pages/RepairFinish.jsx"
import Records from "./pages/Records.jsx"
import Inventory from "./pages/Inventory.jsx"
import Warehouse from "./pages/Warehouse.jsx"
import Profile from "./pages/Profile.jsx"

import BottomNav from "./components/BottomNav.jsx"

import {
  canAccessPage,
  getCurrentUser
} from "./shared/userStore.js"

import "./App.css"


function App() {

  const [isLoggedIn, setIsLoggedIn] = useState(
    localStorage.getItem("isLoggedIn") === "true"
  )

  const [currentUser, setCurrentUser] = useState(() =>
    getCurrentUser()
  )

  const [page, setPageState] = useState("home")

  const [permissionMessage, setPermissionMessage] =
    useState("")


  function handleLogin(user) {

    setCurrentUser(user)
    setIsLoggedIn(true)
    setPageState("home")
    setPermissionMessage("")
  }


  function handleLogout() {

    localStorage.removeItem("isLoggedIn")

    setIsLoggedIn(false)
    setPageState("home")
    setPermissionMessage("")
  }


  function setPage(nextPage) {

    const latestUser = getCurrentUser()

    setCurrentUser(latestUser)


    if (!canAccessPage(nextPage, latestUser)) {

      setPermissionMessage(
        `${latestUser.name}没有权限访问该页面`
      )

      setPageState("home")

      return
    }


    setPermissionMessage("")
    setPageState(nextPage)
  }


  if (!isLoggedIn) {

    return (

      <Login
        onLogin={handleLogin}
      />

    )
  }


  return (

    <div className="app">

      <main className="app-content">

        {permissionMessage && (

          <div className="permission-message">

            {permissionMessage}

          </div>

        )}


        {page === "home" && (

          <Home
            setPage={setPage}
            currentUser={currentUser}
          />

        )}


        {page === "repair" && (

          <Repair
            setPage={setPage}
          />

        )}


        {page === "repairTask" && (

          <RepairTask
            setPage={setPage}
          />

        )}


        {page === "repairWork" && (

          <RepairWork
            setPage={setPage}
          />

        )}


        {page === "repairFinish" && (

          <RepairFinish
            setPage={setPage}
          />

        )}


        {page === "records" && (

          <Records
            setPage={setPage}
          />

        )}


        {page === "inventory" && (

          <Inventory
            setPage={setPage}
          />

        )}


        {page === "warehouse" && (

          <Warehouse
            setPage={setPage}
          />

        )}


        {page === "profile" && (

          <Profile
            setPage={setPage}
            onLogout={handleLogout}
          />

        )}

      </main>


      <BottomNav
        page={page}
        setPage={setPage}
      />

    </div>

  )
}


export default App