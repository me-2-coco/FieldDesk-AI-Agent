import re
import uuid
import json
from datetime import datetime
from pathlib import Path

import streamlit as st
import pandas as pd

from task_manager import APPROVED, UPLOAD_DIR, now_text, save_order
from sn_ocr import recognize_sn_from_uploads
from model_lookup import infer_model_from_sn


st.set_page_config(page_title="FieldDesk 师傅端", page_icon="🛠️", layout="centered")
st.title("🛠️ FieldDesk 维修资料提交")
st.caption("只填写带 * 的必需资料。提交后直接交给 Agent 执行，无需内勤确认。")


KNOWLEDGE_FILE = Path(__file__).resolve().parent / "knowledge" / "fault_mapping.json"


def infer_fault(product_line, machine_model, replacement_parts):
    """用第一项核心故障件匹配历史 CRM 分类，其余配件只参与维修措施。"""
    core_part = replacement_parts[0]
    core_name = core_part["名称"]
    core_code = core_part["编码"]
    result = {
        "一级": "产品质量",
        "二级": "",
        "三级": "",
        "置信度": 0,
        "样本数": 0,
        "判断方式": "等待CRM客户反馈核验",
        "核心故障件": core_name,
    }

    if KNOWLEDGE_FILE.exists():
        try:
            knowledge = json.loads(KNOWLEDGE_FILE.read_text(encoding="utf-8"))
            mappings = knowledge.get("mappings", {})
            keys = (
                f"{product_line}|{machine_model}|{core_code or core_name}",
                f"{product_line}||{core_code or core_name}",
            )
            # 单条历史记录不能代表稳定规则。此前正是把“1 条样本、表面
            # 置信度 100%”当成确定答案，导致第一配件与 CRM 故障不匹配。
            # 只有样本量和一致率同时达标才允许自动带出，否则交给 Agent
            # 结合 CRM 客户报修内容判断，绝不盲填。
            candidates = [mappings[key] for key in keys if key in mappings]
            match = next(
                (
                    candidate
                    for candidate in candidates
                    if int(candidate.get("total", 0)) >= 3
                    and float(candidate.get("confidence", 0)) >= 0.6
                ),
                None,
            )
            if match:
                path = str(match.get("best", {}).get("path", "")).split("|")
                result.update({
                    "一级": path[0] if len(path) > 0 and path[0] else "产品质量",
                    "二级": path[1] if len(path) > 1 else "",
                    "三级": path[2] if len(path) > 2 else "",
                    "置信度": match.get("confidence", 0),
                    "样本数": match.get("total", 0),
                    "判断方式": "核心配件可靠历史映射",
                })
                return result
        except (OSError, ValueError, TypeError):
            pass

    # 新配件没有历史样本时，只给出保守候选；Agent进入CRM后还要以
    # 客户实际反馈为第一依据核验，不能把这里的候选当成最终结论。
    normalized = re.sub(r"售后|组件|总成|\([^)]*\)|（[^）]*）", "", core_name).strip()
    result["三级"] = f"{normalized}不良" if normalized else ""
    return result


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


# 文件上传必须放在表单外：选择照片后 Streamlit 才会立即运行 OCR，
# 并在师傅提交前把识别结果带入 SN 输入框。
st.subheader("一、上传维修资料")
opening_sn_photos = st.file_uploader(
    "开箱及 SN 照片 *",
    type=["jpg", "jpeg", "png"],
    accept_multiple_files=True,
    key="opening_sn_photos",
    help="照片可以混合上传，系统会自动寻找铭牌/SN照片。",
)
finish_media = st.file_uploader(
    "完工视频或照片 *",
    type=["jpg", "jpeg", "png", "mp4", "mov", "avi"],
    accept_multiple_files=True,
    key="finish_media",
)

current_photo_signature = tuple(
    (item.name, item.size) for item in (opening_sn_photos or [])
)
if current_photo_signature and current_photo_signature != st.session_state.get("sn_ocr_signature"):
    with st.spinner("正在从照片识别机器 SN…"):
        ocr_result = recognize_sn_from_uploads(opening_sn_photos)
    st.session_state.sn_ocr_signature = current_photo_signature
    st.session_state.sn_ocr_result = ocr_result
    if ocr_result.get("sn"):
        st.session_state.machine_sn_input = ocr_result["sn"]
        model_result = infer_model_from_sn(ocr_result["sn"])
        st.session_state.model_lookup_result = model_result
        if model_result.get("status") == "matched":
            st.session_state.machine_model_input = model_result["machine_model"]
            product_line = model_result.get("product_line", "")
            if product_line in {"扫地机", "洗地机"}:
                st.session_state.sign_detail_input = product_line
            else:
                st.session_state.sign_detail_input = "请选择"
        else:
            # 换了一张新铭牌照片但无法唯一匹配时，清掉上一单的自动结果，
            # 避免沿用旧型号或旧签收明细。
            st.session_state.machine_model_input = ""
            st.session_state.sign_detail_input = "请选择"

ocr_result = st.session_state.get("sn_ocr_result", {})
if ocr_result.get("sn"):
    if ocr_result.get("needs_confirmation"):
        st.warning(
            f"已从 {ocr_result.get('file_name', '照片')} 识别出 SN：{ocr_result['sn']}。"
            "请师傅核对后再提交。"
        )
    else:
        st.success(
            f"已从 {ocr_result.get('file_name', '照片')} 自动识别 SN：{ocr_result['sn']}"
        )
elif current_photo_signature:
    st.warning("照片中暂未识别到可靠的 SN，请检查照片清晰度或手动填写。")

model_result = st.session_state.get("model_lookup_result", {})
if model_result.get("status") == "matched":
    auto_sign_detail = model_result.get("product_line", "")
    st.success(
        f"已根据 SN 项目编码 {model_result['project_code']} 自动带出型号："
        f"{model_result['machine_model']}"
        + (f"；签收明细：{auto_sign_detail}" if auto_sign_detail in {"扫地机", "洗地机"} else "")
    )
elif model_result.get("status") == "ambiguous":
    st.warning(
        "这个 SN 项目编码对应多个定制机型，请人工选择或填写型号："
        + "、".join(model_result.get("candidates", []))
    )


with st.form("repair_order", clear_on_submit=False):
    st.subheader("二、CRM 定位信息")
    locate_type = st.selectbox(
        "查询编号类型 *",
        ["取件快递单号", "流转单号", "工单号", "订单号", "退换单号", "客户手机号"],
    )
    locate_value = st.text_input("查询编号 *", placeholder="请输入能够在“扫码签收”中查询到寄修单的编号")

    st.subheader("三、产品信息")
    machine_model = st.text_input(
        "机器型号 *",
        key="machine_model_input",
        help="由识别出的 SN 自动匹配；如机型表存在多个候选，可人工修改。",
    )
    sn_code = st.text_input(
        "机器 SN *",
        key="machine_sn_input",
        help="由照片自动识别；如识别有误，可由师傅直接修改。",
    )
    sign_detail = st.selectbox(
        "签收明细 *",
        ["请选择", "扫地机", "洗地机"],
        key="sign_detail_input",
        help="识别型号后会根据机型表中的产品线自动选择。",
    )
    st.caption("仅在 CRM 尚未签收时使用；如果已经签收，Agent 会自动跳过签收环节。")

    st.subheader("四、保修与配件更换")
    warranty = st.selectbox("保内/保外 *", ["请选择", "保内", "保外"])
    st.caption(
        "不再填写故障现象和检测结论。第一行必须填写核心故障件，"
        "Agent 将优先根据 CRM 客户报修内容判断，再用核心故障件核验。"
    )

    st.markdown("**更换配件**")
    st.caption("至少填写一个配件；第一行是核心故障件。可持续新增，不限制种类；数量默认 1。")
    parts_table = st.data_editor(
        pd.DataFrame([{"配件名称": "", "配件编码": "", "数量": 1}]),
        num_rows="dynamic",
        hide_index=True,
        width="stretch",
        column_config={
            "配件名称": st.column_config.TextColumn("配件名称 *", help="例如：喷水器"),
            "配件编码": st.column_config.TextColumn("配件编码 *", help="例如：20020100007717"),
            "数量": st.column_config.NumberColumn(
                "数量 *", min_value=1, step=1, default=1, format="%d"
            ),
        },
        key="replacement_parts_table",
    )
    st.caption("维修措施将由系统按照固定话术自动生成，不需要师傅填写。")

    submitted = st.form_submit_button("提交维修资料", type="primary", width="stretch")


if submitted:
    missing = []
    required_text = {
        "查询编号": locate_value,
        "机器型号": machine_model,
        "机器 SN": sn_code,
        "签收明细": "" if sign_detail == "请选择" else sign_detail,
        "保内/保外": "" if warranty == "请选择" else warranty,
    }
    for label, value in required_text.items():
        if not str(value).strip():
            missing.append(label)

    replacement_parts = []
    for index, row in parts_table.iterrows():
        clean_name = str(row.get("配件名称") or "").strip()
        clean_code = str(row.get("配件编码") or "").strip()
        raw_quantity = row.get("数量")
        if bool(clean_name) != bool(clean_code):
            missing.append(f"配件第{index + 1}行的名称或编码")
        elif clean_name and clean_code:
            try:
                quantity = int(raw_quantity)
            except (TypeError, ValueError):
                quantity = 0
            if quantity < 1:
                missing.append(f"配件第{index + 1}行的数量")
            else:
                replacement_parts.append({"名称": clean_name, "编码": clean_code, "数量": quantity})

    if not replacement_parts:
        missing.append("至少一个更换配件")

    required_files = {
        "开箱及 SN 照片": opening_sn_photos,
        "完工视频或照片": finish_media,
    }
    for label, files in required_files.items():
        if not files:
            missing.append(label)

    if missing:
        st.error("以下资料尚未填写：" + "、".join(missing))
    else:
        order_id = "FD" + datetime.now().strftime("%Y%m%d%H%M%S")
        finish_photo_files = [
            item for item in finish_media
            if Path(item.name).suffix.lower() in {".jpg", ".jpeg", ".png"}
        ]
        finish_video_files = [
            item for item in finish_media
            if Path(item.name).suffix.lower() in {".mp4", ".mov", ".avi"}
        ]
        attachments = {
            "SN照片": save_uploads(order_id, "opening_sn", opening_sn_photos),
            "开箱及外观照片": [],
            "完工照片": save_uploads(order_id, "finish", finish_photo_files),
            "完工视频": save_uploads(order_id, "video", finish_video_files),
        }

        inferred = infer_fault(sign_detail, machine_model.strip(), replacement_parts)
        order = {
            "数据版本": 4,
            "工单编号": order_id,
            "状态": APPROVED,
            "提交时间": now_text(),
            "CRM定位": {"编号类型": locate_type, "编号": locate_value.strip()},
            "客户电话": "",
            "产品名称": "",
            "机器型号": machine_model.strip(),
            "SN": sn_code.strip(),
            "SN识别": {
                "识别值": ocr_result.get("sn", ""),
                "来源文件": ocr_result.get("file_name", ""),
                "置信度": ocr_result.get("confidence", 0),
                "提交值经人工修改": bool(
                    ocr_result.get("sn")
                    and sn_code.strip().upper() != ocr_result.get("sn", "").upper()
                ),
            },
            "型号识别": {
                "项目编码": model_result.get("project_code", ""),
                "识别型号": model_result.get("machine_model", ""),
                "产品线": model_result.get("product_line", ""),
                "状态": model_result.get("status", ""),
                "候选型号": model_result.get("candidates", []),
                "提交值经人工修改": bool(
                    model_result.get("machine_model")
                    and machine_model.strip() != model_result.get("machine_model", "")
                ),
            },
            "签收明细": sign_detail,
            "保内保外": warranty,
            "故障": inferred["二级"],
            "检测结果": inferred["三级"],
            "故障分类": {
                "一级": inferred["一级"],
                "二级": inferred["二级"],
                "三级": inferred["三级"],
            },
            "自动判断": inferred,
            "责任判定": "",
            "维修措施": "",
            "更换配件": replacement_parts,
            "签收回单备注": "",
            "附件": attachments,
            "执行记录": [{
                "时间": now_text(),
                "事件": "师傅提交",
                "说明": (
                    f"核心故障件：{inferred['核心故障件']}；"
                    f"初步判断：{inferred['二级']}/{inferred['三级']}；"
                    "最终以CRM客户反馈优先核验"
                ),
            }],
        }
        save_order(order)
        st.success(f"工单 {order_id} 已提交，可直接运行 Agent。")
