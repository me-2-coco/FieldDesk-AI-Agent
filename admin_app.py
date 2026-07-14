from pathlib import Path

import streamlit as st

from task_manager import (
    APPROVED,
    CRM_FAILED,
    CRM_RMA_OPENED,
    WAITING_REVIEW,
    add_event,
    get_all_orders,
    now_text,
    update_order,
)


st.set_page_config(page_title="FieldDesk 内勤审核", page_icon="📋", layout="wide")
st.title("📋 FieldDesk 内勤审核后台")
st.caption("审核师傅资料、批准 Agent 执行，并查看 CRM 执行结果。")

orders = get_all_orders()
if not orders:
    st.info("暂无工单")
    st.stop()

status_filter = st.multiselect(
    "状态筛选",
    sorted({order.get("状态", "未知") for order in orders}),
    default=[WAITING_REVIEW] if any(order.get("状态") == WAITING_REVIEW for order in orders) else [],
)
visible_orders = [o for o in orders if not status_filter or o.get("状态") in status_filter]

for order in visible_orders:
    order_id = order.get("工单编号", "未知")
    with st.expander(f"{order_id}　｜　{order.get('状态', '未知')}　｜　{order.get('机器型号', '')}", expanded=order.get("状态") == WAITING_REVIEW):
        left, right = st.columns(2)
        with left:
            st.write("**CRM查询编号：**", order.get("CRM定位", {}).get("编号", order.get("快递单号", "")))
            st.write("**查询类型：**", order.get("CRM定位", {}).get("编号类型", ""))
            st.write("**客户电话：**", order.get("客户电话", ""))
            st.write("**机器型号：**", order.get("机器型号", ""))
            st.write("**SN：**", order.get("SN", ""))
            st.write("**保内保外：**", order.get("保内保外", ""))
        with right:
            st.write("**故障：**", order.get("故障", ""))
            st.write("**检测结果：**", order.get("检测结果", ""))
            st.write("**故障分类：**", order.get("故障分类", {}))
            st.write("**维修措施：**", order.get("维修措施", ""))
            st.write("**更换配件：**", "、".join(order.get("更换配件", [])) if isinstance(order.get("更换配件"), list) else order.get("更换配件", ""))

        attachments = order.get("附件", {})
        st.write("**附件数量：**", {name: len(files) for name, files in attachments.items()})

        if order.get("状态") == WAITING_REVIEW:
            if st.button("审核通过并允许 Agent 查询 CRM", key=f"approve_{order_id}", type="primary"):
                update_order(order_id, 状态=APPROVED, 审核时间=now_text())
                add_event(order_id, "内勤审核通过", "允许 Agent 执行第一阶段 CRM 查询")
                st.success("审核通过。现在可以运行 Agent。")
                st.rerun()

        if order.get("状态") == CRM_FAILED:
            st.error(order.get("CRM错误", "CRM 执行失败"))
            if st.button("允许重新执行", key=f"retry_{order_id}"):
                update_order(order_id, 状态=APPROVED, CRM错误="")
                add_event(order_id, "允许重试")
                st.rerun()

        if order.get("状态") == CRM_RMA_OPENED:
            screenshot = order.get("CRM截图", "")
            if screenshot and Path(screenshot).exists():
                st.image(screenshot, caption="Agent 打开的 RMA 页面")
            st.success("Agent 已找到并打开 RMA，等待人工确认后继续开发下一阶段。")

        if order.get("执行记录"):
            st.write("**执行记录**")
            st.dataframe(order["执行记录"], use_container_width=True, hide_index=True)
