import json
from datetime import datetime
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = BASE_DIR / "uploads"
RUNTIME_DIR = BASE_DIR / "runtime"
SCREENSHOT_DIR = RUNTIME_DIR / "screenshots"

for directory in (DATA_DIR, UPLOAD_DIR, RUNTIME_DIR, SCREENSHOT_DIR):
    directory.mkdir(parents=True, exist_ok=True)


WAITING_REVIEW = "等待审核"
APPROVED = "审核通过"
CRM_RUNNING = "CRM处理中"
CRM_RMA_OPENED = "已打开RMA，等待人工确认"
CRM_SIGN_PREVIEW = "签收资料已准备，等待人工确认"
CRM_MANUAL_SIGNED = "人工已签收，等待检测"
CRM_DETECTION_OPENED = "检测窗口已打开，等待确认"
CRM_DETECTION_CONFIRMED = "检测已确认，等待内部维修单"
CRM_REPAIR_OPENED = "维修页面已打开，等待继续"
CRM_REPLACEMENT_ADD_OPENED = "更换件新增窗口已打开，等待继续"
CRM_REPLACEMENT_SAVED = "更换件已保存，等待继续"
CRM_FAULT_MODE_OPENED = "故障模式编辑页已打开，等待继续"
CRM_FAULT_MODE_FILLED = "维修措施已填写，等待确认"
CRM_FAULT_MODE_SAVED = "维修措施已保存，等待继续"
CRM_FINAL_ACTION_READY = "CRM完整流程已准备，等待最终确认"
CRM_FAILED = "CRM处理失败"
COMPLETED = "已完成"


def now_text():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def get_order_file(order_id):
    return DATA_DIR / f"order_{order_id}.json"


def save_order(order):
    order_id = order["工单编号"]
    file_path = get_order_file(order_id)
    temporary_path = file_path.with_suffix(".json.tmp")

    with temporary_path.open("w", encoding="utf-8") as file:
        json.dump(order, file, ensure_ascii=False, indent=2)

    temporary_path.replace(file_path)
    return file_path


def load_order_file(file_path):
    with Path(file_path).open("r", encoding="utf-8") as file:
        order = json.load(file)
    order["_file"] = str(file_path)
    return order


def get_all_orders():
    orders = [load_order_file(path) for path in DATA_DIR.glob("order_*.json")]
    return sorted(orders, key=lambda item: item.get("提交时间", ""), reverse=True)


def get_orders_by_status(*statuses):
    accepted = set(statuses)
    return [order for order in get_all_orders() if order.get("状态") in accepted]


def get_order(order_id):
    file_path = get_order_file(order_id)
    if not file_path.exists():
        return None
    return load_order_file(file_path)


def update_order(order_id, **changes):
    order = get_order(order_id)
    if not order:
        raise FileNotFoundError(f"找不到工单：{order_id}")

    order.pop("_file", None)
    order.update(changes)
    order["最后更新时间"] = now_text()
    save_order(order)
    return order


def add_event(order_id, event, detail=""):
    order = get_order(order_id)
    if not order:
        raise FileNotFoundError(f"找不到工单：{order_id}")

    order.pop("_file", None)
    order.setdefault("执行记录", []).append(
        {"时间": now_text(), "事件": event, "说明": detail}
    )
    order["最后更新时间"] = now_text()
    save_order(order)
    return order


def get_next_approved_order():
    orders = get_orders_by_status(APPROVED, CRM_FAILED)
    return orders[-1] if orders else None
