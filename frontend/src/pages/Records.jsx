import { useMemo, useState } from "react"
import ScannerModal from "../components/ScannerModal.jsx"


function readRepairRecords() {

  try {

    const savedRecords = JSON.parse(
      localStorage.getItem("repairRecords") || "[]"
    )

    return Array.isArray(savedRecords)
      ? savedRecords
      : []

  } catch (error) {

    console.error("维修记录读取失败：", error)

    return []

  }

}


function normalizePhone(value) {

  return String(value || "")
    .replace(/\s/g, "")
    .toLowerCase()

}


function normalizeSn(value) {

  return String(value || "")
    .trim()
    .toLowerCase()

}


function getRecordTime(record) {

  const timeText =
    record.completedAt ||
    record.date ||
    ""

  if (!timeText) {
    return null
  }

  const time = new Date(timeText)

  if (Number.isNaN(time.getTime())) {
    return null
  }

  return time

}


function Records() {

  const currentTechnician = "张师傅"


  const [records] = useState(() =>
    readRepairRecords()
  )


  // 电话或 SN 输入内容
  const [keywordInput, setKeywordInput] =
    useState("")

  // 真正执行搜索的电话或 SN
  const [keywordFilter, setKeywordFilter] =
    useState("")

  const [scannerOpen, setScannerOpen] = useState(false)


  // 日期输入内容
  const [startDateInput, setStartDateInput] =
    useState("")

  const [endDateInput, setEndDateInput] =
    useState("")

  async function handleScan(value){

  const scanValue = String(value || "").trim()


  if(scanValue === ""){

    setMessage("没有识别到有效SN")

    return

  }


  // 关闭扫码窗口

  setScannerOpen(false)



  // 自动填入搜索框

  setKeywordInput(scanValue)


  // 设置搜索条件

  setKeywordFilter(scanValue)



  // 自动触发搜索

  setTimeout(()=>{

    const searchButton =
      document.querySelector(
        "#record-search-button"
      )


    if(searchButton){

      searchButton.click()

    }

  },300)


}


  // 真正执行筛选的日期
  const [startDateFilter, setStartDateFilter] =
    useState("")

  const [endDateFilter, setEndDateFilter] =
    useState("")


  const [message, setMessage] =
    useState("")


  // 判断重复维修
  const recordsWithRepeat = useMemo(() => {

    return records.map((record) => {

      const currentSn =
        normalizeSn(record.sn)

      const currentPhone =
        normalizePhone(record.phone)


      const repeatCount = records.filter((item) => {

        const itemSn =
          normalizeSn(item.sn)

        const itemPhone =
          normalizePhone(item.phone)

        return (
          currentSn !== "" &&
          currentPhone !== "" &&
          itemSn === currentSn &&
          itemPhone === currentPhone
        )

      }).length


      return {
        ...record,
        isRepeatRepair: repeatCount > 1,
        repeatCount
      }

    })

  }, [records])


  // 执行综合筛选
  const filteredRecords = useMemo(() => {

    const keyword =
      keywordFilter
        .trim()
        .toLowerCase()

    return recordsWithRepeat.filter((record) => {

      const recordPhone =
        normalizePhone(record.phone)

      const recordSn =
        normalizeSn(record.sn)


      // 一个输入框同时匹配电话或 SN
      if (
        keyword !== "" &&
        !recordPhone.includes(keyword) &&
        !recordSn.includes(keyword)
      ) {
        return false
      }


      const recordTime =
        getRecordTime(record)


      if (startDateFilter) {

        const startTime = new Date(
          `${startDateFilter}T00:00:00`
        )

        if (
          recordTime &&
          recordTime < startTime
        ) {
          return false
        }

      }


      if (endDateFilter) {

        const endTime = new Date(
          `${endDateFilter}T23:59:59`
        )

        if (
          recordTime &&
          recordTime > endTime
        ) {
          return false
        }

      }


      return true

    })

  }, [
    recordsWithRepeat,
    keywordFilter,
    startDateFilter,
    endDateFilter
  ])


  const myRepairCount = useMemo(() => {

    return filteredRecords.filter(
      (record) =>
        record.technician === currentTechnician
    ).length

  }, [filteredRecords])


  const repeatRepairCount = useMemo(() => {

    return filteredRecords.filter(
      (record) => record.isRepeatRepair
    ).length

  }, [filteredRecords])


  function searchByKeyword() {

    const keyword =
      keywordInput.trim()

    if (keyword === "") {

      setMessage(
        "请输入电话、部分号码、SN 或部分 SN"
      )

      return

    }

    setKeywordFilter(keyword)
    setMessage("")

  }


  function clearKeywordSearch() {

    setKeywordInput("")
    setKeywordFilter("")
    setMessage("")

  }


  function searchByDate() {

    if (
      startDateInput === "" &&
      endDateInput === ""
    ) {

      setMessage("请选择开始日期或结束日期")

      return

    }


    if (
      startDateInput &&
      endDateInput &&
      new Date(startDateInput) >
        new Date(endDateInput)
    ) {

      setMessage(
        "开始日期不能晚于结束日期"
      )

      return

    }


    setStartDateFilter(startDateInput)
    setEndDateFilter(endDateInput)
    setMessage("")

  }


  function clearDateSearch() {

    setStartDateInput("")
    setEndDateInput("")

    setStartDateFilter("")
    setEndDateFilter("")

    setMessage("")

  }


  function handleKeywordKeyDown(event) {

    if (event.key === "Enter") {
      searchByKeyword()
    }

  }


  function getPartStatusText(status) {

    const statusTextMap = {
      used: "已更换",
      return: "申请归还",
      scrap: "损坏或报废",
      pending: "待确认"
    }

    return statusTextMap[status] || "未记录"

  }


  return (

    <div className="page records-page">


      <h1>
        维修记录
      </h1>


      <div className="card records-filter-card">

        <h2>
          搜索全部维修记录
        </h2>


        <p className="filter-description">
          可搜索所有师傅完成的维修记录
        </p>


        {/* 电话或 SN 综合搜索 */}

        <div className="filter-section">

          <label htmlFor="record-keyword">
            电话或 SN
          </label>



<div className="filter-section">

  <div className="scan-input-row">

    <input
      id="record-keyword"
      type="search"
      placeholder="输入电话、部分号码或SN"
      value={keywordInput}
      onChange={(e)=>setKeywordInput(e.target.value)}
    />

    <button
      type="button"
      className="scan-input-button"
      onClick={()=>setScannerOpen(true)}
    >
      扫码
    </button>

  </div>

</div>


          <div className="filter-button-row">

            <button
  id="record-search-button"
  type="button"
  className="filter-search-button"
  onClick={searchByKeyword}
>
  搜索
</button>


            <button
                type="button"
                className="filter-clear-button"
                onClick={clearKeywordSearch}
            >
              清除
            </button>

          </div>

        </div>


        {/* 日期范围搜索 */}

        <div className="filter-section">

          <label>
            日期范围
          </label>


          <div className="date-range-box">

            <div className="date-range-item">

              <span>
                开始
              </span>

              <input
                type="date"
                value={startDateInput}
                onChange={(event) =>
                  setStartDateInput(
                    event.target.value
                  )
                }
                aria-label="开始日期"
              />

            </div>


            <span className="date-range-divider">
              至
            </span>


            <div className="date-range-item">

              <span>
                结束
              </span>

              <input
                type="date"
                value={endDateInput}
                onChange={(event) =>
                  setEndDateInput(
                    event.target.value
                  )
                }
                aria-label="结束日期"
              />

            </div>

          </div>


          <div className="filter-button-row">

            <button
              type="button"
              className="filter-search-button"
              onClick={searchByDate}
            >
              搜索
            </button>


            <button
              type="button"
              className="filter-clear-button"
              onClick={clearDateSearch}
            >
              清除
            </button>

          </div>

        </div>


        {message && (

          <p className="filter-message">
            {message}
          </p>

        )}


        {(keywordFilter ||
          startDateFilter ||
          endDateFilter) && (

          <div className="active-filter-summary">

            <strong>
              当前筛选：
            </strong>


            {keywordFilter && (

              <span>
                电话或 SN：{keywordFilter}
              </span>

            )}


            {(startDateFilter ||
              endDateFilter) && (

              <span>
                日期：
                {startDateFilter || "不限"}

                {" 至 "}

                {endDateFilter || "不限"}
              </span>

            )}

          </div>

        )}

      </div>


      <div className="stats records-stats">

        <div className="card">

          <h3>
            {myRepairCount}
          </h3>

          <p>
            我的维修
          </p>

        </div>


        <div className="card">

          <h3>
            {filteredRecords.length}
          </h3>

          <p>
            全部记录
          </p>

        </div>


        <div className="card">

          <h3>
            {repeatRepairCount}
          </h3>

          <p>
            重复维修
          </p>

        </div>

      </div>


      <div className="card">

        <h2>
          维修记录列表
        </h2>


        <p className="record-result-count">
          共找到 {filteredRecords.length} 条记录
        </p>


        {filteredRecords.length === 0 ? (

          <div className="empty-records">

            <p>
              没有找到符合条件的维修记录
            </p>

          </div>

        ) : (

          filteredRecords
            .slice()
            .sort((firstRecord, secondRecord) => {

              const firstTime =
                getRecordTime(firstRecord)

              const secondTime =
                getRecordTime(secondRecord)

              return (
                (secondTime?.getTime() || 0) -
                (firstTime?.getTime() || 0)
              )

            })
            .map((record, index) => (

              <div
                className="repair-record-item"
                key={
                  record.id ||
                  record.orderId ||
                  `${record.sn}-${index}`
                }
              >

                <div className="record-title-row">

                  <strong>
                    {record.product || "未知产品"}
                  </strong>


                  {record.isRepeatRepair && (

                    <span className="repeat-tag">
                      重复维修 ×
                      {record.repeatCount}
                    </span>

                  )}

                </div>


                <p>
                  维修日期：
                  {record.completedAt ||
                    record.date ||
                    "-"}
                </p>


                <p>
                  维修师傅：
                  {record.technician || "-"}
                </p>


                <p>
                  客户：
                  {record.customer || "-"}
                </p>


                <p>
                  电话：
                  {record.phone || "-"}
                </p>


                <p>
                  SN：
                  {record.sn || "-"}
                </p>


                <div className="record-parts">

                  <strong>
                    更换配件
                  </strong>


                  {!record.parts ||
                  record.parts.length === 0 ? (

                    <p>
                      本次维修未使用配件
                    </p>

                  ) : (

                    record.parts.map(
                      (part, partIndex) => (

                        <div
                          className="record-part-row"
                          key={
                            part.id ||
                            `${part.code}-${partIndex}`
                          }
                        >

                          <span>
                            {part.name || "未知配件"}

                            {" × "}

                            {part.quantity || 0}
                          </span>


                          <span>
                            {getPartStatusText(
                              part.usageStatus
                            )}
                          </span>

                        </div>

                      )
                    )

                  )}

                </div>

              </div>

            ))

        )}

      </div><ScannerModal
  open={scannerOpen}
  title="扫描SN"
  onScan={handleScan}
  onClose={() => setScannerOpen(false)}
/>

    </div>


  )

}



export default Records
