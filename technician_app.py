import re
import uuid
from datetime import datetime
from pathlib import Path

import streamlit as st

from task_manager import UPLOAD_DIR, WAITING_REVIEW, now_text, save_order


st.set_page_config(page_title="FieldDesk 师傅端", page_icon="🛠️", layout="centered")
st.title("🛠️ FieldDesk 维修资料提交")
st.caption("请一次性提交 CRM 回单所需资料。提交后由内勤审核，再交给 Agent 执行。")


def safe_name(name):
    cleaned = re.sub(r"[^0-9A-Za-z._\-\u4e00-\u9fff]", "_", Path(name).name)
    return cleaned[:120] or "file"


def save_uploads(order_id, category, files):
    saved = []
    category_dir = UPLOAD_DIR / order_id / category
    category_dir.mkdir(parents=True, exist_ok=True)

    for uploaded in files or []:
        file_name = f"{uuid.uuid4().hex[:8]}_{safe_name(uploaded.name)}"
        file_path = category_dir / file_name
        file_path.write_bytes(uploaded.getbuffer())
        saved.append(str(file_path.relative_to(UPLOAD_DIR.parent)))
    return saved


with st.form("repair_order", clear_on_submit=False):
    st.subheader("一、CRM 定位信息")
    locate_type = st.selectbox(
        "查询编号类型 *",
        ["取件快递单号", "流转单号", "工单号", "订单号", "退换单号", "客户手机号"],
    )
    locate_value = st.text_input("查询编号 *", placeholder="请输入能够在“扫码签收”中查询到寄修单的编号")

    st.subheader("二、产品与客户信息")
    customer_phone = st.text_input("客户电话")
    product_name = st.text_input("产品名称")
    machine_model = st.text_input("机器型号 *")
    sn_code = st.text_input("机器 SN *")

    st.subheader("三、检测与维修结论")
    warranty = st.selectbox("保内/保外 *", ["请选择", "保内", "保外"])
    fault = st.text_area("故障现象 *", placeholder="例如：机器无法启动，按下开关无反应")
    detection_result = st.text_area("检测结果 *", placeholder="例如：检测确认启动开关组件故障")
    fault_level_1 = st.text_input("故障一级分类", placeholder="例如：产品质量")
    fault_level_2 = st.text_input("故障二级分类", placeholder="例如：电机不启动")
    fault_level_3 = st.text_input("故障三级分类", placeholder="例如：启动开关不良")
    responsibility = st.text_input("责任判定")
    repair_action = st.text_area("维修措施 *", placeholder="例如：更换启动开关组件，清理并试机正常")
    parts = st.text_area("更换配件", placeholder="多个配件请每行填写一个")
    sign_note = st.text_area("签收/回单备注")

    st.subheader("四、照片与视频")
    sn_photos = st.file_uploader(
        "SN 照片 *", type=["jpg", "jpeg", "png"], accept_multiple_files=True
    )
    unpacking_photos = st.file_uploader(
        "开箱及机器外观照片 *", type=["jpg", "jpeg", "png"], accept_multiple_files=True
    )
    finish_photos = st.file_uploader(
        "完工照片 *", type=["jpg", "jpeg", "png"], accept_multiple_files=True
    )
    finish_videos = st.file_uploader(
        "完工试机视频 *", type=["mp4", "mov", "avi"], accept_multiple_files=True
    )

    submitted = st.form_submit_button("提交维修资料", type="primary", use_container_width=True)


if submitted:
    missing = []
    required_text = {
        "查询编号": locate_value,
        "机器型号": machine_model,
        "机器 SN": sn_code,
        "保内/保外": "" if warranty == "请选择" else warranty,
        "故障现象": fault,
        "检测结果": detection_result,
        "维修措施": repair_action,
    }
    for label, value in required_text.items():
        if not str(value).strip():
            missing.append(label)

    required_files = {
        "SN 照片": sn_photos,
        "开箱及外观照片": unpacking_photos,
        "完工照片": finish_photos,
        "完工试机视频": finish_videos,
    }
    for label, files in required_files.items():
        if not files:
            missing.append(label)

    if missing:
        st.error("以下资料尚未填写：" + "、".join(missing))
    else:
        order_id = "FD" + datetime.now().strftime("%Y%m%d%H%M%S")
        attachments = {
            "SN照片": save_uploads(order_id, "sn", sn_photos),
            "开箱及外观照片": save_uploads(order_id, "unpacking", unpacking_photos),
            "完工照片": save_uploads(order_id, "finish", finish_photos),
            "完工视频": save_uploads(order_id, "video", finish_videos),
        }

        order = {
            "数据版本": 1,
            "工单编号": order_id,
            "状态": WAITING_REVIEW,
            "提交时间": now_text(),
            "CRM定位": {"编号类型": locate_type, "编号": locate_value.strip()},
            "客户电话": customer_phone.strip(),
            "产品名称": product_name.strip(),
            "机器型号": machine_model.strip(),
            "SN": sn_code.strip(),
            "保内保外": warranty,
            "故障": fault.strip(),
            "检测结果": detection_result.strip(),
            "故障分类": {
                "一级": fault_level_1.strip(),
                "二级": fault_level_2.strip(),
                "三级": fault_level_3.strip(),
            },
            "责任判定": responsibility.strip(),
            "维修措施": repair_action.strip(),
            "更换配件": [line.strip() for line in parts.splitlines() if line.strip()],
            "签收回单备注": sign_note.strip(),
            "附件": attachments,
            "执行记录": [{"时间": now_text(), "事件": "师傅提交", "说明": "等待内勤审核"}],
        }
        save_order(order)
        st.success(f"工单 {order_id} 已提交，等待内勤审核。")
