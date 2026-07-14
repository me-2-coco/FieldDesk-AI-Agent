import argparse
import re
import sys
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

from task_manager import (
    APPROVED,
    CRM_FAILED,
    CRM_RMA_OPENED,
    CRM_RUNNING,
    RUNTIME_DIR,
    SCREENSHOT_DIR,
    add_event,
    get_next_approved_order,
    get_order,
    update_order,
)


CRM_HOME_URL = "https://crm2.recloud.com.cn/t/dreame/crmweb/index.html#/home"
SESSION_FILE = RUNTIME_DIR / "crm_session.json"
AUTH_HOST = "auth4.recloud.com.cn"
DEFAULT_TIMEOUT_MS = 15_000


def normalize_text(value):
    return re.sub(r"\s+", "", str(value or "")).casefold()


def is_login_page(page):
    return AUTH_HOST in page.url or page.locator("input[type='password']:visible").count() > 0


def click_named(page, name, timeout=DEFAULT_TIMEOUT_MS):
    pattern = re.compile(rf"^\s*{re.escape(name)}\s*$")
    candidates = (
        page.get_by_role("menuitem", name=pattern),
        page.get_by_role("button", name=pattern),
        page.get_by_role("link", name=pattern),
        page.get_by_text(pattern),
    )
    last_error = None
    for locator in candidates:
        try:
            locator.first.wait_for(state="visible", timeout=timeout)
            locator.first.click()
            return
        except Exception as error:
            last_error = error
    raise RuntimeError(f"找不到可点击元素：{name}") from last_error


def open_scan_sign_page(page):
    page.goto(CRM_HOME_URL, wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_timeout(2_000)
    if is_login_page(page):
        raise RuntimeError("CRM 登录会话已失效，请先运行 python crm_login.py 重新登录")

    for menu_name in ("服务管理", "上门工单"):
        try:
            click_named(page, menu_name, timeout=4_000)
            page.wait_for_timeout(500)
        except RuntimeError:
            pass

    click_named(page, "扫码签收")
    page.wait_for_timeout(2_000)
    if is_login_page(page):
        raise RuntimeError("进入扫码签收时登录会话失效，请重新登录")


def find_search_input(page):
    patterns = (
        re.compile("物流单号.*工单号"),
        re.compile("扫码枪"),
        re.compile("物流单号"),
        re.compile("请输入.*编号"),
    )
    for pattern in patterns:
        locator = page.get_by_placeholder(pattern).locator("visible=true")
        if locator.count() == 1:
            return locator.first

    visible_inputs = page.locator("input:visible:not([type='hidden'])")
    editable = []
    for index in range(visible_inputs.count()):
        candidate = visible_inputs.nth(index)
        if not candidate.is_disabled() and not candidate.is_readonly():
            editable.append(candidate)
    if len(editable) == 1:
        return editable[0]
    raise RuntimeError(f"无法唯一定位扫码签收查询输入框（可编辑输入框 {len(editable)} 个）")


def wait_for_search_result(page, locate_value, timeout=DEFAULT_TIMEOUT_MS):
    expected = normalize_text(locate_value)
    page.wait_for_function(
        """expected => {
            const rows = [...document.querySelectorAll('tbody tr, [role="row"]')]
                .filter(row => row.offsetParent !== null);
            return rows.some(row => (row.innerText || '').replace(/\\s+/g, '').toLowerCase().includes(expected));
        }""",
        expected,
        timeout=timeout,
    )


def matching_visible_rows(page, locate_value):
    expected = normalize_text(locate_value)
    rows = page.locator("tbody tr:visible")
    if rows.count() == 0:
        rows = page.locator("[role='row']:visible")

    matches = []
    for index in range(rows.count()):
        row = rows.nth(index)
        if expected in normalize_text(row.inner_text()):
            matches.append(row)
    return matches


def open_rma_from_row(page, row):
    rma_controls = (
        row.get_by_role("link", name=re.compile("RMA", re.I)),
        row.get_by_role("button", name=re.compile("RMA", re.I)),
        row.get_by_text(re.compile(r"^\s*RMA\s*$", re.I)),
    )
    for control in rma_controls:
        if control.count() and control.first.is_visible():
            control.first.click()
            return

    links = row.locator("a:visible")
    if links.count() == 1:
        links.first.click()
        return
    raise RuntimeError("已找到唯一寄修记录，但无法唯一定位该行的 RMA 入口，已安全暂停")


def verify_rma_opened(page, previous_url):
    page.wait_for_timeout(2_500)
    visible_rma = page.get_by_text(re.compile(r"\bRMA\b", re.I)).locator("visible=true")
    dialog = page.locator("[role='dialog']:visible, .el-dialog:visible, .ant-modal:visible")
    url_changed = page.url != previous_url
    if not url_changed and dialog.count() == 0:
        raise RuntimeError("点击 RMA 后页面没有发生可确认的变化，已安全暂停")
    if visible_rma.count() == 0:
        raise RuntimeError("页面已变化，但未确认进入 RMA，已安全暂停")


def search_and_open_rma(page, locate_value):
    search_input = find_search_input(page)
    search_input.fill(locate_value)
    search_input.press("Enter")
    try:
        wait_for_search_result(page, locate_value)
    except PlaywrightTimeoutError as error:
        raise RuntimeError(f"没有查询到包含编号 {locate_value} 的寄修记录") from error

    matches = matching_visible_rows(page, locate_value)
    if not matches:
        raise RuntimeError(f"没有查询到包含编号 {locate_value} 的可见寄修记录")
    if len(matches) != 1:
        raise RuntimeError(f"查询到 {len(matches)} 条可见记录，Agent 已停止，请人工确认")

    previous_url = page.url
    open_rma_from_row(page, matches[0])
    verify_rma_opened(page, previous_url)
    return len(matches)


def save_failure_evidence(page, order_id):
    path = SCREENSHOT_DIR / f"{order_id}_failed.png"
    try:
        page.screenshot(path=str(path), full_page=True)
        return str(path)
    except Exception:
        return ""


def run(order_id=None, keep_open=True):
    order = get_order(order_id) if order_id else get_next_approved_order()
    if not order:
        print("没有可以执行的审核通过工单")
        return 1
    if order.get("状态") not in (APPROVED, CRM_FAILED):
        print(f"工单状态不允许执行：{order.get('状态')}")
        return 1
    if not SESSION_FILE.exists():
        print("尚未保存 CRM 登录会话，请先运行：python crm_login.py")
        return 1

    order_id = order["工单编号"]
    locate_value = order.get("CRM定位", {}).get("编号") or order.get("快递单号")
    if not str(locate_value or "").strip():
        print("工单缺少 CRM 查询编号")
        return 1

    locate_value = str(locate_value).strip()
    update_order(order_id, 状态=CRM_RUNNING, CRM错误="")
    add_event(order_id, "Agent开始执行", f"查询编号：{locate_value}")

    page = None
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=False)
            context = browser.new_context(
                storage_state=str(SESSION_FILE),
                viewport={"width": 1440, "height": 900},
            )
            page = context.new_page()
            page.set_default_timeout(DEFAULT_TIMEOUT_MS)

            open_scan_sign_page(page)
            add_event(order_id, "进入扫码签收")
            match_count = search_and_open_rma(page, locate_value)

            screenshot = SCREENSHOT_DIR / f"{order_id}_rma.png"
            page.screenshot(path=str(screenshot), full_page=True)
            update_order(
                order_id,
                状态=CRM_RMA_OPENED,
                CRM截图=str(screenshot),
                CRM当前网址=page.url,
                CRM匹配记录数=match_count,
                CRM查询编号=locate_value,
            )
            add_event(order_id, "已打开RMA", "唯一记录；安全暂停；未签收、未提交")
            print("成功：已找到唯一寄修记录并打开 RMA。Agent 已安全暂停，没有签收或提交。")

            if keep_open:
                input("请在浏览器中检查页面，确认后按回车关闭浏览器……")
            browser.close()
        return 0
    except Exception as error:
        evidence = save_failure_evidence(page, order_id) if page else ""
        update_order(order_id, 状态=CRM_FAILED, CRM错误=str(error), CRM失败截图=evidence)
        add_event(order_id, "Agent执行失败", str(error))
        print(f"执行失败：{error}")
        return 2


def main():
    parser = argparse.ArgumentParser(description="FieldDesk 真实 CRM Agent（第一阶段安全版）")
    parser.add_argument("--order", help="指定 FieldDesk 工单编号")
    parser.add_argument("--close", action="store_true", help="成功后直接关闭浏览器")
    args = parser.parse_args()
    sys.exit(run(order_id=args.order, keep_open=not args.close))


if __name__ == "__main__":
    main()
