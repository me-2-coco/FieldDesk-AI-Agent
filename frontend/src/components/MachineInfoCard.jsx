function MachineInfoCard({
  machine,
  status = "维修中",
}) {

  const statusClass =
    status === "待提交确认"
      ? "status-confirm"
      : status === "检测中"
      ? "status-working"
      : status === "等待配件"
      ? "status-parts"
      : status === "已完成"
      ? "status-completed"
      : status === "待签收"
      ? "status-waiting"
      : "status-default";


  return (
    <div className="card">

      {/* 机器信息标题 + 状态 */}
      <div className="machine-card-header">

        <h2>
          📦机器信息
        </h2>

        <span className={`repair-status-badge ${statusClass}`}>
          {status}
        </span>

      </div>


      {/* 机器信息内容 */}
      <div className="machine-info-list">

        <p>
          <span className="info-label">
            客户：
          </span>
          {machine?.customer || "暂无"}
        </p>


        <p>
          <span className="info-label">
            电话：
          </span>
          {machine?.phone || "暂无"}
        </p>


        <p>
          <span className="info-label">
            产品：
          </span>
          {machine?.product || machine?.model || "暂无"}
        </p>


        <p>
          <span className="info-label">
            SN：
          </span>
          {machine?.sn || "暂无"}
        </p>


        {
          machine?.logisticsNo && (
            <p>
              <span className="info-label">
                物流单号：
              </span>
              {machine.logisticsNo}
            </p>
          )
        }


        {
          machine?.crmNo && (
            <p>
              <span className="info-label">
                CRM编号：
              </span>
              {machine.crmNo}
            </p>
          )
        }


        {
          machine?.fault && (
            <p>
              <span className="info-label">
                用户故障描述：
              </span>
              {machine.fault}
            </p>
          )
        }

      </div>

    </div>
  );
}


export default MachineInfoCard;