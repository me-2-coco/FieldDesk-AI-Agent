import argparse
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

from task_manager import (
    APPROVED,
    COMPLETED,
    CRM_FAILED,
    CRM_DETECTION_OPENED,
    CRM_DETECTION_CONFIRMED,
    CRM_REPAIR_OPENED,
    CRM_REPLACEMENT_ADD_OPENED,
    CRM_REPLACEMENT_SAVED,
    CRM_FAULT_MODE_OPENED,
    CRM_FAULT_MODE_FILLED,
    CRM_FAULT_MODE_SAVED,
    CRM_RMA_OPENED,
    CRM_SIGN_PREVIEW,
    CRM_RUNNING,
    BASE_DIR,
    RUNTIME_DIR,
    SCREENSHOT_DIR,
    add_event,
    get_next_approved_order,
    get_order,
    update_order,
)


CRM_HOME_URL = (
    "https://crm2.recloud.com.cn/t/dreame/webapp/dreame/"
    "?mainNavName=serviceprovider#/scanSignin/query"
)
SESSION_FILE = RUNTIME_DIR / "crm_session.json"
CHROME_PROFILE_DIR = RUNTIME_DIR / "crm_chrome_profile"
AUTH_HOST = "auth4.recloud.com.cn"
# 普通控件最多等5秒；页面导航、视频上传等慢操作在调用处单独给长超时。
# 避免一个不存在的选择项让整单无意义停顿15秒。
DEFAULT_TIMEOUT_MS = 4_000
# 单个选择项最多用4秒。找到目标后立即点击，不再继续观察或空等。
CHOICE_TIMEOUT_MS = 4_000
CHOICE_POLL_MS = 100
KNOWLEDGE_FILE = BASE_DIR / "knowledge" / "fault_mapping.json"


def step_started(order_id, step):
    """记录可恢复步骤和耗时，失败后不需要从头猜执行到了哪里。"""
    update_order(
        order_id,
        CRM当前步骤=step,
        CRM步骤开始时间=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    )
    add_event(order_id, "开始步骤", step)
    return time.monotonic()


def step_finished(order_id, step, started_at, detail=""):
    elapsed = round(time.monotonic() - started_at, 1)
    order = get_order(order_id) or {}
    completed = list(order.get("CRM已完成步骤") or [])
    if step not in completed:
        completed.append(step)
    update_order(
        order_id,
        CRM当前步骤="",
        CRM已完成步骤=completed,
        CRM最后步骤耗时秒=elapsed,
    )
    add_event(order_id, "完成步骤", f"{step}；{elapsed}秒" + (f"；{detail}" if detail else ""))
    print(f"[耗时] {step}: {elapsed}秒" + (f"（{detail}）" if detail else ""), flush=True)


def validate_core_fault(order):
    """阻止低质量历史样本把第一配件映射成无关故障。"""
    parts = replacement_parts(order)
    core_name, core_code, _ = parts[0]
    inferred = order.get("自动判断") or {}
    categories = order.get("故障分类") or {}
    method = str(inferred.get("判断方式") or "")
    inferred_core = normalize_text(inferred.get("核心故障件"))
    if inferred_core and inferred_core != normalize_text(core_name):
        raise RuntimeError("故障判断使用的核心配件不是更换配件第一项，已停止防止错单")

    path = [categories.get("一级"), categories.get("二级"), categories.get("三级")]
    # 一级、二级可以先沿用 CRM 客服登记值；三级必须由第一核心配件/实际
    # 故障确定。后续页面若发现当前二级下没有合适三级，才允许改二级。
    if not str(path[2] or "").strip():
        raise RuntimeError("第一配件没有可用的三级故障判断，已停止防止错单")

    # 兼容已经提交的旧工单：重新核验其历史映射质量。
    if "历史映射" in method and KNOWLEDGE_FILE.exists():
        knowledge = json.loads(KNOWLEDGE_FILE.read_text(encoding="utf-8"))
        mappings = knowledge.get("mappings", {})
        product_line = str(order.get("产品线") or order.get("签收明细") or "")
        model = str(order.get("机器型号") or "")
        keys = (f"{product_line}|{model}|{core_code}", f"{product_line}||{core_code}")
        reliable = [
            mappings[key]
            for key in keys
            if key in mappings
            and int(mappings[key].get("total", 0)) >= 3
            and float(mappings[key].get("confidence", 0)) >= 0.6
        ]
        if not reliable:
            raise RuntimeError(
                f"第一配件“{core_name}”的历史故障映射样本不足或分歧过大，"
                "禁止自动选择CRM故障"
            )
    return path


def normalize_text(value):
    return re.sub(r"\s+", "", str(value or "")).casefold()


def wait_until(predicate, timeout_ms=CHOICE_TIMEOUT_MS, poll_ms=CHOICE_POLL_MS):
    """短轮询等待；选择类动作绝不无提示地停留几十秒。"""
    deadline = time.monotonic() + timeout_ms / 1000
    last_error = None
    while time.monotonic() < deadline:
        try:
            if predicate():
                return True
        except Exception as error:
            last_error = error
        time.sleep(poll_ms / 1000)
    if last_error:
        return False
    return False


def is_login_page(page):
    return AUTH_HOST in page.url or page.locator("input[type='password']:visible").count() > 0


def goto_if_needed(page, target_url, timeout=20_000):
    """当前已经在目标页时不刷新，保留 SPA 状态并节省重新加载时间。"""
    if page.url == target_url and not is_login_page(page):
        print("[加速] 已复用当前CRM页面，跳过重复加载。", flush=True)
        return False
    page.goto(target_url, wait_until="domcontentloaded", timeout=timeout)
    return True


def click_named(page, name, timeout=DEFAULT_TIMEOUT_MS):
    # 安全红线：FieldDesk 只负责录入与保存，绝不允许自动点击 CRM“完工”。
    # 即使调用方误传该名称，也必须在动作发生前终止。
    if normalize_text(name) == normalize_text("完工"):
        raise RuntimeError("安全拦截：Agent 禁止点击 CRM‘完工’按钮")
    pattern = re.compile(rf"^\s*{re.escape(name)}\s*$")
    candidates = (
        page.get_by_role("menuitem", name=pattern),
        page.get_by_role("button", name=pattern),
        page.get_by_role("link", name=pattern),
        page.get_by_text(pattern),
    )
    # 所有定位方式共用一个总超时。旧逻辑会让四种定位方式
    # 分别等满 timeout，一个不存在的按钮最坏要白等 60 秒。
    deadline = time.monotonic() + timeout / 1000
    last_error = None
    while time.monotonic() < deadline:
        for locator in candidates:
            try:
                for index in range(locator.count()):
                    target = locator.nth(index)
                    if target.is_visible() and target.is_enabled():
                        target.scroll_into_view_if_needed(timeout=1_000)
                        target.click(timeout=2_000)
                        return
            except Exception as error:
                last_error = error
        page.wait_for_timeout(CHOICE_POLL_MS)
    raise RuntimeError(f"找不到可点击元素：{name}") from last_error


def find_search_input(page):
    patterns = (
        "请用扫码枪输入",
        "物流单号/工单号",
        "物流单号",
        "请输入",
    )

    for pattern in patterns:
        locator = page.get_by_placeholder(pattern)

        visible = []

        for index in range(locator.count()):
            item = locator.nth(index)

            if item.is_visible() and item.is_enabled():
                visible.append(item)

        if len(visible) == 1:
            return visible[0]

    # 用 Chrome 恢复后可能本来就在扫码签收页。旧代码仍会无条件
    # 重新加载整个 CRM，既慢又会丢失当前 SPA 页面状态。
    inputs = page.locator(
        "input:visible:not([type='hidden'])"
    )

    candidates = []

    for index in range(inputs.count()):
        item = inputs.nth(index)

        if not item.is_editable():
            continue

        box = item.bounding_box()

        if not box:
            continue

        # 排除左侧菜单搜索框
        if box["x"] > 300:
            candidates.append(item)

    if len(candidates) == 1:
        return candidates[0]

    raise RuntimeError(
        f"无法唯一定位扫码签收输入框，候选数量：{len(candidates)}"
    )


def open_scan_sign_page(page):
    if not is_login_page(page):
        try:
            find_search_input(page)
            print("[加速] 扫码签收页已经可用，跳过CRM首页加载。", flush=True)
            return
        except RuntimeError:
            pass

    goto_if_needed(page, CRM_HOME_URL)
    wait_until(
        lambda: is_login_page(page)
        or page.locator("input:visible:not([type='hidden'])").count() > 0,
        timeout_ms=5_000,
    )
    if is_login_page(page):
        raise RuntimeError("CRM 登录会话已失效，请先运行 python crm_login.py 重新登录")

    # 正确入口会直接进入扫码签收页；能找到查询框就无需再点菜单。
    try:
        find_search_input(page)
        return
    except RuntimeError:
        pass

    for menu_name in ("服务管理", "上门工单"):
        try:
            click_named(page, menu_name, timeout=4_000)
        except RuntimeError:
            pass

    click_named(page, "扫码签收")
    wait_until(
        lambda: is_login_page(page)
        or page.locator("input:visible:not([type='hidden'])").count() > 0,
        timeout_ms=5_000,
    )
    if is_login_page(page):
        raise RuntimeError("进入扫码签收时登录会话失效，请重新登录")

def wait_for_search_result(page, locate_value, timeout=DEFAULT_TIMEOUT_MS):
    expected = normalize_text(locate_value)
    page.wait_for_function(
        """expected => {
            const rows = [...document.querySelectorAll('tbody tr, [role="row"]')]
                .filter(row => row.offsetParent !== null);
            return rows.some(row => (row.innerText || '').replace(/\\s+/g, '').toLowerCase().includes(expected));
        }""",
        arg=expected,
        timeout=timeout,
    )


def is_rma_open(page):
    if "rma" in page.url.casefold():
        return True
    rma_text = page.get_by_text(re.compile(r"^\s*RMA(?:\s|$)", re.I))
    return any(rma_text.nth(index).is_visible() for index in range(rma_text.count()))


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
    wait_until(
        lambda: page.url != previous_url
        or page.locator("[role='dialog']:visible, .el-dialog:visible, .ant-modal:visible").count() > 0,
        timeout_ms=5_000,
    )
    rma_text = page.get_by_text(re.compile(r"\bRMA\b", re.I))
    visible_rma_count = sum(
        1 for index in range(rma_text.count()) if rma_text.nth(index).is_visible()
    )
    dialog = page.locator("[role='dialog']:visible, .el-dialog:visible, .ant-modal:visible")
    url_changed = page.url != previous_url
    if not url_changed and dialog.count() == 0:
        raise RuntimeError("点击 RMA 后页面没有发生可确认的变化，已安全暂停")
    if visible_rma_count == 0:
        raise RuntimeError("页面已变化，但未确认进入 RMA，已安全暂停")


def search_and_open_rma(page, locate_value):
    search_input = find_search_input(page)
    search_input.fill(locate_value)
    search_input.press("Enter")
    # 直接进入 RMA 时立即继续；有结果表时也不再固定等 3 秒。
    wait_until(
        lambda: is_rma_open(page) or bool(matching_visible_rows(page, locate_value)),
        timeout_ms=5_000,
    )

    # 瑞云当前版本会在回车后直接进入唯一 RMA，无需经过结果列表。
    if is_rma_open(page):
        return 1

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

def read_rma_info(page):
    print("开始读取RMA页面")

    text = page.locator("body").inner_text()

    print(text[:2000])

    return text

def save_failure_evidence(page, order_id):
    path = SCREENSHOT_DIR / f"{order_id}_failed.png"
    try:
        page.screenshot(path=str(path), full_page=True)
        return str(path)
    except Exception:
        return ""


def attachment_paths(order, categories=None):
    paths = []
    seen = set()
    attachments = order.get("附件", {})
    selected_categories = categories or tuple(attachments)
    for category in selected_categories:
        category_paths = attachments.get(category, [])
        for relative_path in category_paths:
            path = (BASE_DIR / relative_path).resolve()
            if not path.exists():
                raise RuntimeError(f"附件不存在：{relative_path}")
            resolved = str(path)
            if resolved not in seen:
                paths.append(resolved)
                seen.add(resolved)
    if not paths:
        raise RuntimeError("工单没有可上传的附件")
    return paths


def visible_dialog(page):
    dialogs = page.locator(
        "[role='dialog']:visible, .el-dialog:visible, .ant-modal:visible"
    )
    if dialogs.count() == 0:
        raise RuntimeError("操作后没有出现预期弹窗")
    return dialogs.last


def wait_for_dialog(page, timeout_ms=DEFAULT_TIMEOUT_MS):
    """等待弹窗真正出现；出现即返回，不做固定空等。"""
    if not wait_until(
        lambda: page.locator(
            "[role='dialog']:visible, .el-dialog:visible, .ant-modal:visible"
        ).count() > 0,
        timeout_ms=timeout_ms,
        poll_ms=CHOICE_POLL_MS,
    ):
        raise RuntimeError("操作后没有出现预期弹窗")
    return visible_dialog(page)


def upload_rma_attachments(page, paths):
    # 一次性传入师傅端提交的全部完工照片和视频。Playwright 直接操作
    # file input，不打开系统文件选择窗口，也不依赖个人电脑手工选文件。
    paths = list(dict.fromkeys(str(Path(path).resolve()) for path in paths))
    expected_names = [Path(path).name for path in paths]
    if not expected_names:
        raise RuntimeError("没有可上传的附件")
    click_named(page, "上传附件")
    dialog = wait_for_dialog(page)
    file_inputs = dialog.locator("input[type='file']")
    if file_inputs.count() == 0:
        raise RuntimeError("上传附件弹窗中没有找到文件选择控件")

    file_input = file_inputs.last
    multiple = file_input.get_attribute("multiple") is not None
    if len(paths) > 1 and not multiple:
        raise RuntimeError("CRM附件控件当前不支持多选，已停止以避免只上传第一个文件")

    print(f"准备上传全部附件（{len(paths)}个）：" + "、".join(expected_names))
    file_input.set_input_files(paths)

    # 文件名全部出现在上传弹窗后才允许点击“上传”，避免大视频尚未加入
    # 队列时提前确认，造成只传一部分。
    staged_deadline = time.monotonic() + 8
    missing_staged = list(expected_names)
    while missing_staged and time.monotonic() < staged_deadline:
        dialog_text = dialog.inner_text()
        missing_staged = [name for name in expected_names if name not in dialog_text]
        if missing_staged:
            page.wait_for_timeout(CHOICE_POLL_MS)
    if missing_staged:
        raise RuntimeError(
            "以下附件没有进入CRM待上传列表：" + "、".join(missing_staged)
        )

    upload_candidates = (
        dialog.get_by_role("button", name=re.compile(r"^\s*上传\s*$")),
        dialog.locator("button:visible").filter(has_text=re.compile(r"^\s*上传\s*$")),
        dialog.locator(
            ".el-button:visible, .ant-btn:visible, .ivu-btn:visible, "
            ".arco-btn:visible, [class*='button']:visible, [class*='btn']:visible"
        ).filter(
            has_text=re.compile(r"^\s*上传\s*$")
        ),
        dialog.get_by_text(re.compile(r"^\s*上传\s*$")),
        dialog.locator("xpath=.//*[normalize-space(text())='上传']"),
    )
    upload_button = None
    for candidate in upload_candidates:
        visible = [
            candidate.nth(index)
            for index in range(candidate.count())
            if candidate.nth(index).is_visible()
        ]
        if visible:
            upload_button = visible[-1]
            break
    if upload_button is not None:
        upload_button.click(force=True)
    else:
        click_result = dialog.evaluate(
            """dialog => {
                const visible = element => {
                    const style = getComputedStyle(element);
                    const rect = element.getBoundingClientRect();
                    return style.visibility !== 'hidden' && style.display !== 'none'
                        && rect.width > 0 && rect.height > 0;
                };
                const exactText = [...dialog.querySelectorAll('*')]
                    .filter(element => visible(element)
                        && (element.textContent || '').trim() === '上传');
                const leaves = exactText.filter(element =>
                    ![...element.children].some(child =>
                        (child.textContent || '').trim() === '上传'));
                const label = leaves.at(-1) || exactText.at(-1);
                if (!label) return null;
                const target = label.closest(
                    'button, [role="button"], a, .el-button, .ant-btn, '
                    + '.ivu-btn, .arco-btn, [class*="button"], [class*="btn"]'
                ) || label;
                for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
                    target.dispatchEvent(new MouseEvent(type, {
                        bubbles: true,
                        cancelable: true,
                        view: window
                    }));
                }
                return {tag: target.tagName, className: String(target.className || '')};
            }"""
        )
        if click_result is None:
            # 瑞云当前上传控件的确认按钮未暴露标准按钮语义。
            # 最后的安全兜底只点击当前上传弹窗右下角，不触碰页面其它按钮。
            box = dialog.bounding_box()
            if not box:
                raise RuntimeError("上传附件弹窗中没有找到上传按钮")
            page.mouse.click(
                box["x"] + box["width"] - 72,
                box["y"] + box["height"] - 34,
            )

    try:
        # 两个视频可能接近单文件上限，给CRM充足的网络上传时间。
        dialog.wait_for(state="hidden", timeout=180_000)
    except PlaywrightTimeoutError as error:
        raise RuntimeError("附件上传超过3分钟仍未完成，已安全暂停") from error
    # 弹窗关闭只代表前端结束操作，不代表 CRM 已经保存附件。必须在附件
    # 列表中逐个看到文件名，才能把此步骤标记为成功。
    missing = list(expected_names)
    deadline = time.monotonic() + 12
    while missing and time.monotonic() < deadline:
        page.wait_for_timeout(CHOICE_POLL_MS)
        body_text = page.locator("body").inner_text()
        missing = [name for name in expected_names if name not in body_text]
    if missing:
        raise RuntimeError(
            "附件弹窗虽已关闭，但CRM列表未显示以下文件：" + "、".join(missing)
        )


def crm_has_attachments(page, paths):
    """只相信 CRM 当前页面，不再仅凭本地步骤记录判断附件已上传。"""
    expected_names = [Path(path).name for path in paths]
    if not expected_names:
        return False
    try:
        body_text = page.locator("body").inner_text(timeout=2_000)
    except Exception:
        return False
    return all(name in body_text for name in expected_names)


def form_item_by_label(container, label):
    # 快路径：从准确标签直接向上找所属表单项。旧实现每处理一个字段
    # 都遍历弹窗内全部表单项并读取 inner_text，复杂页面会反复做大量 DOM 查询。
    exact_labels = container.get_by_text(
        re.compile(rf"^\s*{re.escape(label)}\s*\*?\s*$")
    )
    direct_matches = []
    for index in range(exact_labels.count()):
        node = exact_labels.nth(index)
        if not node.is_visible():
            continue
        item = node.locator(
            "xpath=ancestor::*["
            "contains(concat(' ', normalize-space(@class), ' '), ' el-form-item ') or "
            "contains(concat(' ', normalize-space(@class), ' '), ' ant-form-item ') or "
            "contains(@class, 'form-item') or contains(@class, 'formItem')"
            "][1]"
        )
        if item.count() and item.first.is_visible():
            direct_matches.append(item.first)
    if len(direct_matches) == 1:
        return direct_matches[0]

    # 兼容少数没有标准 label 节点的旧页面，才执行全表单扫描。
    items = container.locator(
        ".el-form-item, .ant-form-item, .rt-form-item, .rtxpc-form-item, "
        "[class*='form-item'], [class*='formItem']"
    )
    matches = []
    for index in range(items.count()):
        item = items.nth(index)
        if label in item.inner_text() and item.is_visible():
            matches.append(item)
    return matches[0] if len(matches) == 1 else None


def detection_item(dialog, label):
    item = form_item_by_label(dialog, label)
    if item is not None:
        return item
    labels = dialog.get_by_text(re.compile(rf"^\s*{re.escape(label)}\s*\*?\s*$"))
    for index in range(labels.count()):
        node = labels.nth(index)
        if not node.is_visible():
            continue
        ancestor = node.locator(
            "xpath=ancestor::*[self::div or self::label][.//input or .//textarea][1]"
        )
        if ancestor.count():
            return ancestor.first
    raise RuntimeError(f"检测窗口找不到字段：{label}")


def fill_detection_text(dialog, label, value):
    item = detection_item(dialog, label)
    fields = item.locator("textarea:visible, input:visible:not([disabled])")
    for index in range(fields.count() - 1, -1, -1):
        field = fields.nth(index)
        if field.is_editable():
            field.fill(str(value or ""))
            return
    raise RuntimeError(f"检测字段不可填写：{label}")


def choose_detection_option(page, dialog, label, value):
    item = detection_item(dialog, label)
    controls = item.locator(
        "[role='combobox']:visible, input:visible:not([disabled]), "
        "[class*='select']:visible"
    )
    if controls.count() == 0:
        raise RuntimeError(f"检测字段没有下拉控件：{label}")
    controls.last.click(force=True)
    option = page.get_by_text(re.compile(rf"^\s*{re.escape(str(value))}\s*$"))
    visible = []

    def find_visible_option():
        visible.clear()
        count = option.count()
        for index in range(count - 1, -1, -1):
            candidate = option.nth(index)
            if candidate.is_visible():
                visible.append(candidate)
                return True
        return False

    wait_until(find_visible_option)
    if not visible:
        raise RuntimeError(f"检测字段‘{label}’没有选项：{value}")
    target = visible[-1]
    box = target.bounding_box()
    if box:
        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    else:
        target.click(force=True)

    def option_was_applied():
        expected = normalize_text(value)
        fields = item.locator("input:visible, textarea:visible")
        for index in range(fields.count()):
            try:
                if expected in normalize_text(fields.nth(index).input_value()):
                    return True
            except Exception:
                pass
        return expected in normalize_text(item.inner_text())

    if not wait_until(option_was_applied):
        raise RuntimeError(f"检测字段‘{label}’选择后未回填：{value}")


def choose_detection_radio(dialog, label, value):
    item = detection_item(dialog, label)
    option = item.get_by_text(re.compile(rf"^\s*{re.escape(value)}\s*$"))
    visible = [option.nth(i) for i in range(option.count()) if option.nth(i).is_visible()]
    if not visible:
        raise RuntimeError(f"检测字段‘{label}’没有单选项：{value}")
    visible[-1].click(force=True)


def choose_detection_cascade(page, dialog, label, values):
    item = detection_item(dialog, label)
    inputs = item.locator("input:visible:not([disabled])")
    if inputs.count():
        control = inputs.first
        box = control.bounding_box()
        if not box:
            raise RuntimeError(f"检测字段无法定位级联控件：{label}")
        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    else:
        labels = dialog.get_by_text(re.compile(rf"^\s*{re.escape(label)}\s*$"))
        visible_labels = [labels.nth(i) for i in range(labels.count()) if labels.nth(i).is_visible()]
        if not visible_labels:
            raise RuntimeError(f"检测字段没有级联控件：{label}")
        label_box = visible_labels[-1].bounding_box()
        item_box = item.bounding_box()
        if not label_box or not item_box:
            raise RuntimeError(f"检测字段无法定位级联控件：{label}")
        page.mouse.click(item_box["x"] + item_box["width"] / 2, label_box["y"] + label_box["height"] + 30)
    # 菜单已经可见即可逐级选择，不做固定等待。

    previous_box = None
    for index, value in enumerate(values):
        option = page.get_by_text(re.compile(rf"^\s*{re.escape(str(value))}\s*$"))
        visible = []
        # 瑞云的故障分类是多列级联菜单。选项较多时，目标可能位于
        # 当前可视区域下方；逐列滚动当前最右侧菜单，直到找到目标。
        deadline = time.monotonic() + CHOICE_TIMEOUT_MS / 1000
        while time.monotonic() < deadline:
            visible = [option.nth(i) for i in range(option.count()) if option.nth(i).is_visible()]
            if visible:
                break
            # 如果目标已存在于 DOM，只是被菜单裁剪，直接让浏览器把
            # 它滚入可视区。这只会滚动目标所属的那一列。
            if option.count():
                try:
                    option.last.scroll_into_view_if_needed(timeout=800)
                except Exception:
                    pass
            # 鼠标必须位于当前级的右侧选项列内，浏览器滚轮才会作用于
            # 该列（瑞云页面会忽略在外层容器触发的滚轮事件）。
            if previous_box:
                viewport = page.evaluate("() => ({width: innerWidth, height: innerHeight})")
                mouse_x = min(
                    viewport["width"] - 80,
                    previous_box["x"] + previous_box["width"] + 260,
                )
                mouse_y = min(
                    viewport["height"] - 120,
                    previous_box["y"] + 250,
                )
                page.mouse.move(mouse_x, mouse_y)
                page.mouse.wheel(0, 520)
            page.wait_for_timeout(CHOICE_POLL_MS)
        if not visible:
            raise RuntimeError(f"检测分类第{index + 1}级没有选项：{value}")
        target = visible[-1]
        target.hover()
        previous_box = target.bounding_box()
        if index == len(values) - 1:
            box = target.bounding_box()
            if not box:
                raise RuntimeError(f"检测分类无法点击：{value}")
            page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)


def current_detection_cascade_path(dialog, label):
    """读取客服已经登记的故障路径，先尝试保留其一级、二级。"""
    item = detection_item(dialog, label)
    inputs = item.locator("input:visible:not([disabled])")
    values = []
    for index in range(inputs.count()):
        try:
            value = str(inputs.nth(index).input_value() or "").strip()
        except Exception:
            continue
        if value:
            values.append(value)
    text = values[0] if values else ""
    if not text:
        return []
    return [part.strip() for part in re.split(r"\s*/\s*", text) if part.strip()]


def choose_fault_path(page, dialog, categories):
    """三级优先；当前二级找不到合适三级时，才改成师傅端判断的二级。"""
    label = "故障分类（快速选择）"
    level_1 = "产品质量" if categories.get("一级") == "质量问题" else categories.get("一级")
    level_2 = str(categories.get("二级") or "").strip()
    level_3 = str(categories.get("三级") or "").strip()
    if not level_3:
        raise RuntimeError("缺少三级故障，禁止提交不完整检测结果")

    current = current_detection_cascade_path(dialog, label)
    attempts = []
    # 规则一：先查 CRM 当前二级下面能否选到目标三级。
    if len(current) >= 2:
        attempts.append([current[0], current[1], level_3])
    # 规则二：只有上一步不满足，才使用核心配件推导出的二级、三级。
    if level_1 and level_2:
        fallback = [level_1, level_2, level_3]
        if fallback not in attempts:
            attempts.append(fallback)
    if not attempts:
        raise RuntimeError("CRM当前二级无法读取，且师傅端没有可靠二级故障")

    errors = []
    for path in attempts:
        page.keyboard.press("Escape")
        try:
            choose_detection_cascade(page, dialog, label, path)
            return path
        except RuntimeError as error:
            errors.append(str(error))
    raise RuntimeError("；".join(errors))


def fill_detection_preview(page, dialog, order):
    validate_core_fault(order)
    categories = order.get("故障分类", {})
    choose_fault_path(page, dialog, categories)
    fill_detection_text(dialog, "品质描述", order.get("检测结果") or order.get("故障"))
    choose_detection_radio(dialog, "是否与客服登记原因一致", "否")
    choose_detection_option(page, dialog, "保修状态", order.get("保内保外") or "保内")
    choose_detection_option(page, dialog, "检测结果", "维修")
    # 当前业务流程不要求填写责任判定，保持空白。
    fill_detection_text(dialog, "故障描述", order.get("故障"))
    choose_detection_option(page, dialog, "成品功能判断", "功能问题")
    choose_detection_radio(dialog, "是否原厂耗材", "是")
    # 当前业务流程中“耗材名称”无需填写，保持空白。
    choose_detection_radio(dialog, "是否拆封", "否")


def fill_sign_preview(page, order):
    # 瑞云不同账号/页面版本会把同一动作显示为“签收”或“代客户收件”。
    # 上传完成后先滚动到产品/RMA明细区域，再按实际可见名称点击。
    page.keyboard.press("Escape")
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")

    # 优先点击 RMA 明细数据行最右侧的“签收”。上方“代客户收件”必须先
    # 勾选数据行，直接点击只会提示“请选择一条记录”。
    sign_pattern = re.compile(r"^\s*签收\s*$")
    sign_links = page.get_by_text(sign_pattern)
    visible_sign_links = [
        sign_links.nth(index)
        for index in range(sign_links.count())
        if sign_links.nth(index).is_visible()
    ]
    if visible_sign_links:
        target = visible_sign_links[-1]
        target.scroll_into_view_if_needed()
        target.click(force=True)
    else:
        # 部分账号不显示行内“签收”，此时勾选唯一数据行后使用
        # “代客户收件”。若行数不唯一则停止，避免操作错单。
        rows = page.locator("tbody tr:visible")
        data_rows = [
            rows.nth(index)
            for index in range(rows.count())
            if normalize_text(rows.nth(index).inner_text())
        ]
        if len(data_rows) != 1:
            raise RuntimeError(
                f"没有行内‘签收’，且RMA明细不是唯一数据行（{len(data_rows)}条）"
            )
        checkbox = data_rows[0].locator("input[type='checkbox']")
        if checkbox.count():
            checkbox.first.check(force=True)
        else:
            check_role = data_rows[0].get_by_role("checkbox")
            if not check_role.count():
                raise RuntimeError("RMA唯一数据行没有找到选择框")
            check_role.first.check(force=True)
        click_named(page, "代客户收件", timeout=5_000)

    dialog = wait_for_dialog(page)

    # CRM 当前版本的实际字段名是“实际”，旧版本曾显示“实物”。
    try:
        choose_detection_radio(dialog, "物流单号是否与实际一致", "是")
    except RuntimeError:
        choose_detection_radio(dialog, "物流单号是否与实物一致", "是")

    sn = str(order.get("SN") or "").strip()
    if not sn:
        raise RuntimeError("师傅端工单缺少SN，不能自动确认签收")
    fill_detection_text(dialog, "SN码核对", sn)

    note = order.get("签收回单备注") or order.get("签收明细")
    if not note:
        raise RuntimeError("师傅端工单缺少签收明细")
    try:
        fill_detection_text(dialog, "签收明细备注", note)
    except RuntimeError:
        fill_detection_text(dialog, "签收回单备注", note)

    return dialog


def open_detection_preview(page):
    page.keyboard.press("Escape")
    pattern = re.compile(r"^\s*检测\s*$")
    page.mouse.move(700, 700)
    for _ in range(8):
        candidates = (
            page.get_by_role("button", name=pattern),
            page.get_by_role("link", name=pattern),
            page.get_by_text(pattern),
        )
        for locator in candidates:
            for index in range(locator.count()):
                target = locator.nth(index)
                if target.is_visible():
                    target.scroll_into_view_if_needed()
                    box = target.bounding_box()
                    if not box:
                        continue
                    # 瑞云表格同时渲染普通列和右侧固定列，两个“检测”按钮会重叠。
                    # 按屏幕坐标执行真实左键点击，让浏览器命中最上层的固定列按钮。
                    page.mouse.click(
                        box["x"] + box["width"] / 2,
                        box["y"] + box["height"] / 2,
                        button="left",
                    )
                    return wait_for_dialog(page)
        # CRM 主体是内嵌滚动区；在主体中央模拟真人滚轮，触发下方表格渲染。
        page.mouse.wheel(0, 550)
        page.wait_for_timeout(CHOICE_POLL_MS)

    raise RuntimeError("已滚动RMA主内容区，但仍没有找到可见的‘检测’入口")


def click_rma_table_action(page, action_name):
    pattern = re.compile(rf"^\s*{re.escape(action_name)}\s*$")
    page.mouse.move(700, 700)
    for _ in range(8):
        candidates = (
            page.get_by_role("button", name=pattern),
            page.get_by_role("link", name=pattern),
            page.get_by_text(pattern),
        )
        for locator in candidates:
            for index in range(locator.count()):
                target = locator.nth(index)
                if not target.is_visible():
                    continue
                target.scroll_into_view_if_needed()
                box = target.bounding_box()
                if not box:
                    continue
                pages_before = list(page.context.pages)
                page.mouse.click(
                    box["x"] + box["width"] / 2,
                    box["y"] + box["height"] / 2,
                    button="left",
                )
                # 只给新页签一个很短的发现窗口；同页 SPA 直接交给后续
                # 元素条件等待，不在这里固定空等。
                wait_until(
                    lambda: len(page.context.pages) > len(pages_before),
                    timeout_ms=800,
                    poll_ms=CHOICE_POLL_MS,
                )
                new_pages = [candidate for candidate in page.context.pages if candidate not in pages_before]
                if new_pages:
                    target_page = new_pages[-1]
                    target_page.wait_for_load_state("domcontentloaded", timeout=20_000)
                    target_page.bring_to_front()
                    return target_page
                return page
        page.mouse.wheel(0, 550)
        page.wait_for_timeout(CHOICE_POLL_MS)
    raise RuntimeError(f"RMA明细没有找到可见的‘{action_name}’入口")


def ensure_service_report_page(page):
    """从 RMA 明细可靠进入维修服务单，并兼容延迟打开的新标签页。"""
    tab_pattern = re.compile(r"^\s*服务报告\s*$")

    def page_has_service_report(candidate):
        try:
            locator = candidate.get_by_text(tab_pattern)
            return any(locator.nth(i).is_visible() for i in range(locator.count()))
        except Exception:
            return False

    if page_has_service_report(page):
        page.bring_to_front()
        return page

    context = page.context
    known_pages = list(context.pages)

    # 检测确认后，瑞云会把原来的“维修”操作改成“维修单”列中的 FWD 单号。
    # 再次进入时必须点击该维修单号；只有尚未生成维修单时才点击“维修”。
    repair_links = page.get_by_text(re.compile(r"^\s*FWD\d+\s*$"))
    visible_repair_links = [
        repair_links.nth(i)
        for i in range(repair_links.count())
        if repair_links.nth(i).is_visible()
    ]
    if len(visible_repair_links) > 1:
        raise RuntimeError("RMA中找到多个维修单号，无法安全确定要进入哪一个")
    if visible_repair_links:
        target = visible_repair_links[0]
        target.scroll_into_view_if_needed()
        box = target.bounding_box()
        if not box:
            raise RuntimeError("维修单号可见，但无法定位点击位置")
        page.mouse.click(
            box["x"] + box["width"] / 2,
            box["y"] + box["height"] / 2,
            button="left",
        )
    else:
        page = click_rma_table_action(page, "维修")

    # 出现即继续，总等待上限5秒；旧实现存在嵌套1秒等待，最坏会远超15秒。
    deadline = time.monotonic() + DEFAULT_TIMEOUT_MS / 1000
    while time.monotonic() < deadline:
        candidates = list(context.pages)
        # 新标签页优先，其次检查当前及其它已存在页面。
        candidates.sort(key=lambda item: item in known_pages)
        for candidate in candidates:
            if candidate.is_closed():
                continue
            if page_has_service_report(candidate):
                candidate.bring_to_front()
                return candidate
        page.wait_for_timeout(CHOICE_POLL_MS)

    raise RuntimeError("已点击‘维修’，但5秒内未进入含‘服务报告’的服务单页面")


def handle_warranty_conversion(page, order):
    """按实际 CRM 规则处理产品信息中的“保外转保内”确认。"""
    # 业务规则已确认：无论机器原本保内还是保外，该确认框都选“否”。
    # “否”不会产生任何业务变更，因此 Agent 不再点击“保外转保内”入口。
    # 这也避免瑞云表格的隐藏 DOM 副本造成误点或假弹窗。
    return False

    # 该入口只会在部分产品记录中出现；没有出现时无需处理。
    entry_pattern = re.compile(r"^\s*保外转保内\s*$")
    entries = page.get_by_text(entry_pattern)
    visible_entries = [
        entries.nth(i) for i in range(entries.count()) if entries.nth(i).is_visible()
    ]
    if not visible_entries:
        return False
    target = visible_entries[0]
    if len(visible_entries) > 1:
        # 瑞云会在隐藏的表格副本、普通列和固定操作列中重复渲染
        # 同一个入口，它们的 y 坐标也可能不同。当前 RMA 已在前置步骤
        # 确认为唯一产品记录，因此只选择屏幕中最靠下、最靠右的
        # 真实操作列入口，不再把 DOM 副本误判为多条业务记录。
        boxed = []
        for entry in visible_entries:
            box = entry.bounding_box()
            if box:
                boxed.append((entry, box))
        if len(boxed) != len(visible_entries):
            raise RuntimeError("部分‘保外转保内’入口无法定位，已停止以防点错")
        target, target_box = max(
            boxed,
            key=lambda item: (
                item[1]["y"] + item[1]["height"] / 2,
                item[1]["x"] + item[1]["width"] / 2,
            ),
        )
        target.scroll_into_view_if_needed()
        page.mouse.click(
            target_box["x"] + target_box["width"] / 2,
            target_box["y"] + target_box["height"] / 2,
            button="left",
        )
    else:
        target.scroll_into_view_if_needed()
        target.click(force=True)
    page.wait_for_timeout(600)

    dialogs = page.locator("[role='dialog']:visible, .el-dialog:visible, .ant-modal:visible")
    if dialogs.count() == 0:
        raise RuntimeError("点击‘保外转保内’后没有出现确认窗口")
    dialog = dialogs.last
    if "是否将此产品从保外转为保内" not in normalize_text(dialog.inner_text()):
        raise RuntimeError("出现的不是‘保外转保内确认’窗口，已停止")

    # 业务规则：机器原本保内或保外，在此确认窗口都选择“否”。
    # 其它保修相关分支不在这里自动处理，留给人工。
    no_button = dialog.get_by_role("button", name=re.compile(r"^\s*否\s*$"))
    visible_no = [
        no_button.nth(i) for i in range(no_button.count()) if no_button.nth(i).is_visible()
    ]
    if len(visible_no) != 1:
        raise RuntimeError("保外转保内确认窗口没有找到唯一的‘否’按钮")
    visible_no[0].click(force=True)
    dialog.wait_for(state="hidden", timeout=10_000)
    page.wait_for_timeout(500)
    return True


def open_product_info_tab(page):
    """在内部维修单中明确切换到“产品信息”页签。"""
    pattern = re.compile(r"^\s*产品信息\s*$")
    candidates = page.get_by_role("tab", name=pattern)
    visible = [
        candidates.nth(i)
        for i in range(candidates.count())
        if candidates.nth(i).is_visible()
    ]
    if not visible:
        candidates = page.get_by_text(pattern)
        visible = [
            candidates.nth(i)
            for i in range(candidates.count())
            if candidates.nth(i).is_visible()
        ]
    if not visible:
        raise RuntimeError("内部维修单没有找到‘产品信息’页签")
    visible[-1].click(force=True)


def open_replacement_add_preview(page):
    # 只能进入“服务报告”，不能在“变更记录”等其它页签里新增。
    tab_pattern = re.compile(r"^\s*服务报告\s*$")
    tabs = page.get_by_role("tab", name=tab_pattern)
    visible_tabs = [tabs.nth(i) for i in range(tabs.count()) if tabs.nth(i).is_visible()]
    if visible_tabs:
        visible_tabs[-1].click(force=True)
    else:
        click_named(page, "服务报告", timeout=DEFAULT_TIMEOUT_MS)

    heading_pattern = re.compile(r"^\s*服务单更换件明细\s*$")
    headings = page.get_by_text(heading_pattern)
    visible = [headings.nth(i) for i in range(headings.count()) if headings.nth(i).is_visible()]
    if not visible:
        raise RuntimeError("服务报告中没有找到‘服务单更换件明细’区域")
    heading = visible[-1]
    heading.scroll_into_view_if_needed()

    heading_box = heading.bounding_box()
    if not heading_box:
        raise RuntimeError("无法定位‘服务单更换件明细’标题")

    # 瑞云同一页面有多个“新增”。只点击与该标题处在同一横行、距离最近的按钮。
    buttons = page.get_by_role("button", name=re.compile(r"^\s*新增\s*$"))
    candidates = []
    heading_y = heading_box["y"] + heading_box["height"] / 2
    for index in range(buttons.count()):
        button = buttons.nth(index)
        if not button.is_visible():
            continue
        box = button.bounding_box()
        if not box:
            continue
        button_y = box["y"] + box["height"] / 2
        vertical_distance = abs(button_y - heading_y)
        if vertical_distance <= 90:
            candidates.append((vertical_distance, button, box))

    if len(candidates) != 1:
        raise RuntimeError(
            f"‘服务单更换件明细’同一行匹配到 {len(candidates)} 个新增按钮，已停止以防填错"
        )

    _, target, box = candidates[0]
    if not target.is_visible():
        raise RuntimeError("服务单更换件明细区域的‘新增’按钮不可见")
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    if not wait_until(
        lambda: page.locator(
            "[role='dialog']:visible, .el-dialog:visible, .ant-modal:visible"
        ).count() > 0
    ):
        raise RuntimeError("点击更换件新增后5秒内没有出现窗口")
    dialog = visible_dialog(page)

    # 对目标窗口做二次校验。错误窗口不允许继续填写或保存。
    dialog_text = normalize_text(dialog.inner_text())
    if "新件信息" not in dialog_text or "新件名称" not in dialog_text:
        raise RuntimeError("打开的不是‘服务单更换件明细-新增’窗口，已停止")
    return dialog


def replacement_parts(order):
    parts = order.get("更换配件") or []
    if isinstance(parts, str):
        parts = [parts]
    if not parts:
        raise RuntimeError("工单没有更换配件")

    parsed = []
    seen_codes = set()
    for item in parts:
        if isinstance(item, dict):
            name = str(item.get("名称") or item.get("配件名称") or "").strip()
            code = str(item.get("编码") or item.get("配件编码") or "").strip()
            try:
                quantity = int(item.get("数量", 1))
            except (TypeError, ValueError):
                quantity = 0
            if quantity < 1:
                raise RuntimeError(f"更换配件数量无效：{item}")
            if not re.fullmatch(r"\d{8,}", code):
                raise RuntimeError(f"更换配件缺少可识别编码：{item}")
            if not name:
                raise RuntimeError(f"更换配件缺少名称：{item}")
            if code not in seen_codes:
                seen_codes.add(code)
                parsed.append((name, code, quantity))
            continue
        raw = str(item).strip()
        quantity_match = re.search(r"(?:^|\s)[xX×](\d+)\s*$", raw)
        quantity = int(quantity_match.group(1)) if quantity_match else 1
        if quantity < 1:
            raise RuntimeError(f"更换配件数量无效：{raw}")
        raw_without_quantity = (
            raw[:quantity_match.start()].strip() if quantity_match else raw
        )
        code_match = re.search(r"(?<!\d)(\d{8,})(?!\d)", raw_without_quantity)
        if not code_match:
            raise RuntimeError(f"更换配件缺少可识别编码：{raw}")
        code = code_match.group(1)
        name = (
            raw_without_quantity[:code_match.start()]
            + raw_without_quantity[code_match.end():]
        ).strip(" -_/，,")
        if not name:
            raise RuntimeError(f"更换配件缺少名称：{raw}")
        if code in seen_codes:
            continue
        seen_codes.add(code)
        parsed.append((name, code, quantity))
    return parsed


def select_replacement_part(page, dialog, part_name, part_code):
    item = detection_item(dialog, "新件名称")
    controls = item.locator("input:visible:not([disabled])")
    if controls.count() == 0:
        raise RuntimeError("更换件新增窗口找不到新件名称选择框")
    # “新件名称”是带放大镜的选择控件，不是普通文本框。
    # 必须点击该字段右侧放大镜，等待配件选择窗口出现；禁止在主窗口其它搜索框里填编码。
    dialogs = page.locator("[role='dialog']:visible, .el-dialog:visible, .ant-modal:visible")
    dialog_count_before = dialogs.count()
    field = controls.last
    field.scroll_into_view_if_needed()
    box = field.bounding_box()
    if not box:
        raise RuntimeError("无法定位新件名称右侧的查询按钮")
    # 瑞云的放大镜没有独立按钮语义，必须像真人一样点击输入框最右侧图标。
    page.mouse.click(
        box["x"] + box["width"] - 22,
        box["y"] + box["height"] / 2,
        button="left",
    )

    deadline = time.monotonic() + CHOICE_TIMEOUT_MS / 1000
    while time.monotonic() < deadline:
        page.wait_for_timeout(CHOICE_POLL_MS)
        dialogs = page.locator(
            "[role='dialog']:visible, .el-dialog:visible, .ant-modal:visible"
        )
        if dialogs.count() > dialog_count_before:
            break
    else:
        raise RuntimeError("点击新件名称后没有出现配件选择窗口，已停止")

    if dialogs.count() <= dialog_count_before:
        raise RuntimeError("未能唯一确认新件名称的配件选择窗口，已停止")
    lookup = dialogs.last
    search_fields = lookup.locator("input:visible:not([disabled])")
    editable = []
    for index in range(search_fields.count()):
        field = search_fields.nth(index)
        if field.is_editable():
            editable.append(field)
    if not editable:
        raise RuntimeError("配件选择窗口没有找到搜索框")

    # 配件选择弹窗中只允许使用查询输入框，不使用底层更换件窗口的任何字段。
    search = editable[0] if len(editable) == 1 else editable[-1]
    search.fill(part_code)
    search.press("Enter")
    rows = lookup.locator("tbody tr:visible, [role='row']:visible")

    def matching_rows():
        return [
            rows.nth(index)
            for index in range(rows.count())
            if part_code in normalize_text(rows.nth(index).inner_text())
        ]

    matches = []
    if wait_until(lambda: bool(matches.extend(matching_rows()) or matches)):
        # 去掉轮询过程中可能累积的同一 DOM 行。
        matches = matching_rows()
    if len(matches) != 1:
        raise RuntimeError(f"配件编码 {part_code} 匹配到 {len(matches)} 条记录，已停止")

    row = matches[0]
    row.click(force=True)
    checkbox = row.locator("[role='checkbox'], input[type='checkbox']")
    if checkbox.count():
        try:
            checkbox.first.click(force=True)
        except Exception:
            pass

    confirm = lookup.get_by_role(
        "button", name=re.compile(r"^\s*(确定|确认|选择)\s*$")
    )
    visible_confirm = [
        confirm.nth(i) for i in range(confirm.count()) if confirm.nth(i).is_visible()
    ]
    if visible_confirm:
        visible_confirm[-1].click(force=True)
    else:
        row.dblclick(force=True)
    # 只以当前新增窗口中的“新件编码”精确回填作为成功条件。一旦命中立即推进。
    def selected_code_matches():
        try:
            code_item = detection_item(dialog, "新件编码")
            values = code_item.locator("input:visible, textarea:visible")
            for index in range(values.count()):
                if normalize_text(values.nth(index).input_value()) == normalize_text(part_code):
                    return True
            return normalize_text(part_code) in normalize_text(code_item.inner_text())
        except Exception:
            return False

    if not wait_until(selected_code_matches):
        raise RuntimeError(f"选择配件后5秒内未回填正确编码：{part_code}")


def save_replacement(page, dialog, part):
    part_name, part_code, quantity = part
    select_replacement_part(page, dialog, part_name, part_code)
    try:
        quantity_item = detection_item(dialog, "数量")
        quantity_fields = quantity_item.locator("input:visible:not([disabled])")
    except RuntimeError:
        quantity_fields = dialog.locator("input:visible:not([disabled])")

    editable_quantity_fields = []
    for index in range(quantity_fields.count()):
        candidate = quantity_fields.nth(index)
        if not candidate.is_editable():
            continue
        # 瑞云的数量默认值为 1；当 form-item 标签和输入框被拆分
        # 渲染时，用该默认值锁定数量框。新件序列号等其它可编辑框为空。
        if str(candidate.input_value()).strip() == "1":
            editable_quantity_fields.append(candidate)
    if len(editable_quantity_fields) == 1:
        quantity_field = editable_quantity_fields[0]
    elif quantity_fields.count() == 1 and quantity_fields.first.is_editable():
        quantity_field = quantity_fields.first
    else:
        raise RuntimeError("更换件新增窗口无法唯一定位数量输入框")
    quantity_field.fill(str(quantity))
    quantity_field.press("Tab")
    save = dialog.get_by_role("button", name=re.compile(r"^\s*保存\s*$"))
    visible_save = [save.nth(i) for i in range(save.count()) if save.nth(i).is_visible()]
    if not visible_save:
        # 瑞云部分页面把弹窗底部按钮渲染在 dialog 的兄弟节点中。
        # 只能接受视觉位置位于当前弹窗范围内的按钮，禁止误点背景页顶部
        # 的“保存/完工”等流程按钮。
        dialog_box = dialog.bounding_box()
        if not dialog_box:
            raise RuntimeError("更换件新增窗口无法定位，禁止使用页面级保存兜底")
        global_save = page.get_by_text(re.compile(r"^\s*保存\s*$"))
        for i in range(global_save.count()):
            candidate = global_save.nth(i)
            if not candidate.is_visible():
                continue
            candidate_box = candidate.bounding_box()
            if not candidate_box:
                continue
            center_x = candidate_box["x"] + candidate_box["width"] / 2
            center_y = candidate_box["y"] + candidate_box["height"] / 2
            if (
                dialog_box["x"] <= center_x <= dialog_box["x"] + dialog_box["width"]
                and dialog_box["y"] <= center_y <= dialog_box["y"] + dialog_box["height"]
            ):
                visible_save.append(candidate)
    if not visible_save:
        raise RuntimeError("更换件新增窗口没有找到保存按钮")

    # 选择弹窗中位置最靠右下的“保存”，避免误点背景页顶部的同名按钮。
    positioned = []
    for candidate in visible_save:
        candidate_box = candidate.bounding_box()
        if candidate_box:
            positioned.append(
                (candidate_box["y"], candidate_box["x"], candidate, candidate_box)
            )
    if not positioned:
        raise RuntimeError("更换件新增窗口的保存按钮无法定位")
    positioned.sort(key=lambda item: (item[0], item[1]))
    _, _, target, box = positioned[-1]
    target.scroll_into_view_if_needed()

    def click_save():
        try:
            target.click(button="left", force=True, timeout=2_000)
        except Exception:
            page.mouse.click(
                box["x"] + box["width"] / 2,
                box["y"] + box["height"] / 2,
                button="left",
            )

    # 瑞云偶尔吞掉第一次保存事件。2.5秒未关闭就只重试一次，总等待不超过5秒。
    click_save()
    if not wait_until(lambda: not dialog.is_visible(), timeout_ms=2_500):
        click_save()
        if not wait_until(lambda: not dialog.is_visible(), timeout_ms=2_500):
            raise RuntimeError(
                "更换件编码已校验正确，但保存点击两次后窗口仍未关闭；请检查必填提示"
            )
    return part_name, part_code, quantity


def open_fault_mode_edit(page, order):
    # 必须在“服务报告 → 故障模式及责任判定”中双击已有数据行，不能点击新增。
    click_named(page, "服务报告", timeout=DEFAULT_TIMEOUT_MS)
    heading = page.get_by_text(re.compile(r"^\s*故障模式及责任判定\s*$"))
    visible_headings = [
        heading.nth(i) for i in range(heading.count()) if heading.nth(i).is_visible()
    ]
    if not visible_headings:
        raise RuntimeError("服务报告中没有找到‘故障模式及责任判定’区域")
    title = visible_headings[-1]
    title.scroll_into_view_if_needed()

    title_box = title.bounding_box()
    if not title_box:
        raise RuntimeError("无法定位‘故障模式及责任判定’区域")

    # 不点击分类文字。查找该标题正下方最近的表格数据行，再双击行内空白位置。
    rows = page.locator("tbody tr:visible")
    candidates = []
    for index in range(rows.count()):
        row = rows.nth(index)
        box = row.bounding_box()
        if not box or box["y"] <= title_box["y"]:
            continue
        vertical_distance = box["y"] - (title_box["y"] + title_box["height"])
        if 0 <= vertical_distance <= 260:
            candidates.append((vertical_distance, -box["width"], row, box))
    if not candidates:
        raise RuntimeError("‘故障模式及责任判定’下方没有找到表格数据行")

    candidates.sort(key=lambda item: (item[0], item[1]))
    _, _, target_row, box = candidates[0]
    textareas_before = page.locator("textarea:visible:not([disabled])").count()

    def edit_page_opened():
        return page.locator("textarea:visible:not([disabled])").count() > textareas_before

    # 首选：直接对数据行元素触发双击，事件会由表格行本身接收。
    target_row.dblclick(
        force=True,
        position={"x": max(12, box["width"] - 36), "y": box["height"] / 2},
        delay=120,
    )
    if not wait_until(edit_page_opened, timeout_ms=2_500, poll_ms=CHOICE_POLL_MS):
        # 瑞云部分固定列表格只监听原生 dblclick，使用 DOM 事件作为第二种方式。
        target_row.dispatch_event("dblclick")
        if not wait_until(edit_page_opened, timeout_ms=2_500, poll_ms=CHOICE_POLL_MS):
            raise RuntimeError("双击故障模式数据行后没有打开编辑页面")


def repair_measure_text(order):
    # 优先使用师傅端/内勤已经确认的完整话术。
    confirmed = str(order.get("维修措施") or "").strip()
    if confirmed:
        return confirmed

    fault = str(order.get("故障") or "").strip()
    parts = replacement_parts(order)
    part_names = [name for name, _, _ in parts]
    detection_result = str(order.get("检测结果") or "").strip()
    if len(part_names) == 1 and detection_result.endswith("不良") and len(detection_result) > 2:
        # 配件编码决定实际物料；维修话术使用师傅确认的检测部件名称，
        # 避免师傅端配件文本中的同音字/录入笔误进入 CRM。
        part_names = [detection_result[:-2].strip()]
    if not fault or not part_names:
        raise RuntimeError("缺少故障现象或更换配件，无法生成维修措施")
    # 同一配件即使数量大于 1，也只描述一次；不同配件按照师傅端
    # 的填写顺序逐项说明，避免“检测A、B不良，更换A、B”含义含混。
    unique_part_names = list(dict.fromkeys(part_names))
    if len(unique_part_names) == 1:
        part_name = unique_part_names[0]
        return (
            f"{fault}，客诉故障复现，检测{part_name}不良，"
            f"更换{part_name}，清理，测试ok寄回"
        )

    actions = [
        f"检测{unique_part_names[0]}不良，更换{unique_part_names[0]}"
    ]
    actions.extend(
        f"另检测{part_name}不良，更换{part_name}"
        for part_name in unique_part_names[1:]
    )
    return (
        f"{fault}无法使用，客诉故障复现，"
        + "，".join(actions)
        + "，清理，测试ok寄回"
    )


def fill_fault_mode_edit(page, order):
    value = repair_measure_text(order)
    textareas = page.locator("textarea:visible:not([disabled])")
    candidates = []
    for index in range(textareas.count()):
        field = textareas.nth(index)
        if not field.is_editable():
            continue
        box = field.bounding_box()
        if not box:
            continue
        candidates.append((box["width"] * box["height"], index, field))
    if not candidates:
        raise RuntimeError("故障模式编辑页没有找到可填写文本框")
    # 弹出的“维修措施”是当前编辑页中面积最大的文本框；底层页面即使仍在 DOM 中也不会被选中。
    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    field = candidates[0][2]
    field.fill(value)
    actual = field.input_value()
    if normalize_text(actual) != normalize_text(value):
        raise RuntimeError("维修措施填写后校验不一致，已停止")
    return value


def save_fault_mode_edit(page):
    title = page.get_by_text(re.compile(r"^\s*故障模式及责任判定\s*$"))
    visible_titles = [
        title.nth(i) for i in range(title.count()) if title.nth(i).is_visible()
    ]
    if not visible_titles:
        raise RuntimeError("故障模式编辑页标题不可见")
    container = visible_titles[-1].locator(
        "xpath=ancestor::*[.//textarea and .//button[normalize-space(.)='保存']][1]"
    )
    if container.count() == 0:
        raise RuntimeError("故障模式编辑页没有找到保存按钮")
    save = container.first.get_by_role("button", name=re.compile(r"^\s*保存\s*$"))
    visible_save = [save.nth(i) for i in range(save.count()) if save.nth(i).is_visible()]
    if len(visible_save) != 1:
        raise RuntimeError(f"故障模式编辑页匹配到 {len(visible_save)} 个保存按钮，已停止")
    target = visible_save[0]
    target.click(force=True)
    if not wait_until(lambda: not container.first.is_visible(), timeout_ms=2_500):
        # 与更换件保存一致：CRM吞事件时只补点一次，不反复观察。
        target.click(force=True)
        if not wait_until(lambda: not container.first.is_visible(), timeout_ms=2_500):
            raise RuntimeError("维修措施保存点击两次后页面仍未关闭，可能存在校验提示")


def run(order_id=None, keep_open=True, stage="rma"):
    order = get_order(order_id) if order_id else get_next_approved_order()
    if not order:
        print("没有可以执行的审核通过工单")
        return 1
    allowed_statuses = (
        APPROVED,
        CRM_FAILED,
        CRM_RMA_OPENED,
        CRM_SIGN_PREVIEW,
        "CRM签收完成，等待检测",
        CRM_DETECTION_OPENED,
        "人工已签收，等待检测",
        "签收照片已上传，人工已签收，等待检测",
        "检测资料已自动填写，等待人工确认",
        CRM_DETECTION_CONFIRMED,
        CRM_REPAIR_OPENED,
        CRM_REPLACEMENT_ADD_OPENED,
        CRM_REPLACEMENT_SAVED,
        CRM_FAULT_MODE_OPENED,
        CRM_FAULT_MODE_FILLED,
        CRM_FAULT_MODE_SAVED,
    )
    if order.get("状态") not in allowed_statuses and not (
        stage == "warranty-confirm" and order.get("状态") == COMPLETED
    ):
        print(f"工单状态不允许执行：{order.get('状态')}")
        return 1
    if not SESSION_FILE.exists():
        print("尚未保存 CRM 登录会话，请先运行：python crm_login.py")
        return 1

    order_id = order["工单编号"]
    resume_status = order.get("状态")
    locate_value = order.get("CRM定位", {}).get("编号") or order.get("快递单号")
    if not str(locate_value or "").strip():
        print("工单缺少 CRM 查询编号")
        return 1

    locate_value = str(locate_value).strip()
    update_order(order_id, 状态=CRM_RUNNING, CRM错误="")
    add_event(order_id, "Agent开始执行", f"查询编号：{locate_value}")
    agent_started_at = time.monotonic()

    try:
        with sync_playwright() as playwright:
            # 使用电脑中正式安装的 Google Chrome，避免 Playwright 自带的
            # "Google Chrome for Testing" 在 macOS 上异常退出。
            CHROME_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
            browser_started_at = time.monotonic()
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=str(CHROME_PROFILE_DIR),
                headless=False,
                channel="chrome",
                viewport={"width": 1440, "height": 900},
            )
            print(
                f"[耗时] 启动Agent专用Chrome: "
                f"{round(time.monotonic() - browser_started_at, 1)}秒",
                flush=True,
            )
            # 第二道保险：在浏览器事件层拦截文本恰好为“完工”的点击。
            # 只拦截这个按钮，不影响“保存”“确认”等正常自动操作。
            context.add_init_script(
                """
                document.addEventListener('click', event => {
                    const target = event.target && event.target.closest(
                        'button, a, [role="button"], .el-button, .ant-btn'
                    );
                    if (target && (target.innerText || target.textContent || '').trim() === '完工') {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                    }
                }, true);
                """
            )
            try:
                page_open_started_at = time.monotonic()
                saved_rma_url = str(order.get("CRM当前网址") or "")
                saved_repair_url = str(order.get("CRM维修页面网址") or "")
                # 只复用专用 Chrome profile 中的登录会话，不复用旧标签页。
                # 瑞云 CRM 是 SPA，旧页经常残留弹窗、级联选择器和失效组件，
                # 直接接着操作会造成卡住、误点或 Chrome 异常退出。
                stale_pages = [item for item in context.pages if not item.is_closed()]
                page = context.new_page()
                for stale_page in stale_pages:
                    try:
                        stale_page.close(run_before_unload=False)
                    except Exception:
                        pass
                page.set_default_timeout(DEFAULT_TIMEOUT_MS)
                if stage in (
                    "complete-repair",
                    "replacement-add-preview",
                    "replacement-fill-save",
                    "fault-mode-preview",
                    "fault-mode-fill-preview",
                    "fault-mode-fill-save",
                    "finish-video-upload",
                ) and saved_repair_url:
                    goto_if_needed(page, saved_repair_url)
                    if is_login_page(page):
                        raise RuntimeError("CRM登录会话已失效，请重新保存登录会话")
                    match_count = int(order.get("CRM匹配记录数") or 1)
                    add_event(order_id, "直接打开内部维修单", f"准备执行：{stage}")
                elif stage in (
                    "warranty-confirm",
                    "detection-preview",
                    "detection-fill-preview",
                    "detection-confirm",
                    "repair-preview",
                ) and "rma" in saved_rma_url.casefold():
                    goto_if_needed(page, saved_rma_url)
                    if is_login_page(page):
                        raise RuntimeError("CRM登录会话已失效，请重新保存登录会话")
                    if not is_rma_open(page):
                        raise RuntimeError("保存的RMA地址已失效，无法进入检测阶段")
                    match_count = int(order.get("CRM匹配记录数") or 1)
                    add_event(order_id, "直接打开已签收RMA", "跳过扫码签收查询")
                else:
                    open_scan_sign_page(page)
                    add_event(order_id, "进入扫码签收")
                    match_count = search_and_open_rma(page, locate_value)

                print(
                    f"[耗时] 打开并定位CRM工单: "
                    f"{round(time.monotonic() - page_open_started_at, 1)}秒",
                    flush=True,
                )

                screenshot = SCREENSHOT_DIR / f"{order_id}_rma.png"
                # CRM 页面非常长，整页截图会触发大量滚动区域渲染。
                # 日常留证只截当前窗口；失败时仍由 save_failure_evidence 单独留证。
                page.screenshot(path=str(screenshot), full_page=False)
                update_order(
                    order_id,
                    状态=(
                        order.get("状态")
                        if stage == "warranty-confirm"
                        else CRM_RMA_OPENED
                    ),
                    CRM截图=str(screenshot),
                    CRM当前网址=(
                        saved_rma_url
                        if stage in (
                            "warranty-confirm",
                            "complete-repair",
                            "replacement-add-preview",
                            "replacement-fill-save",
                            "fault-mode-preview",
                            "fault-mode-fill-preview",
                            "fault-mode-fill-save",
                            "finish-video-upload",
                        ) and saved_rma_url
                        else page.url
                    ),
                    CRM匹配记录数=match_count,
                    CRM查询编号=locate_value,
                )
                add_event(order_id, "已打开RMA", "唯一记录；安全暂停；未签收、未提交")

                if stage == "warranty-confirm":
                    # 必须从RMA点击 FWD 维修单号进入，再在产品信息中处理。
                    page = ensure_service_report_page(page)
                    open_product_info_tab(page)
                    handled = handle_warranty_conversion(page, order)
                    if handled:
                        add_event(
                            order_id,
                            "保外转保内确认",
                            "无论原本保内或保外，均已按规则选择否",
                        )
                        update_order(order_id, 状态=COMPLETED)
                        print("成功：已点击‘保外转保内’，并在确认窗口选择‘否’。")
                    else:
                        update_order(order_id, 状态=COMPLETED)
                        print("当前产品信息没有出现‘保外转保内’入口，未执行其它操作。")
                elif stage == "complete-repair":
                    workflow_started_at = time.monotonic()
                    # 某些瑞云页面点击“维修”会在新标签页打开内部维修单；
                    # 若当前仍是RMA详情，先点击并切换到新页面。
                    service_page_started_at = step_started(order_id, "进入内部维修单")
                    page = ensure_service_report_page(page)
                    step_finished(order_id, "进入内部维修单", service_page_started_at)

                    open_product_info_tab(page)
                    if handle_warranty_conversion(page, order):
                        add_event(order_id, "保外转保内确认", "无论原本保内或保外，均已按规则选择否")

                    validate_core_fault(order)
                    saved_parts = []
                    completed_steps = set(
                        (get_order(order_id) or {}).get("CRM已完成步骤") or []
                    )
                    part_step = step_started(order_id, "保存全部更换配件")
                    for part in replacement_parts(order):
                        part_name, part_code, part_quantity = part
                        item_step = f"保存更换配件:{part_code}"
                        if item_step in completed_steps:
                            saved_parts.append(part)
                            add_event(
                                order_id,
                                "跳过已完成更换件",
                                f"{part_name} / {part_code}",
                            )
                            continue
                        item_started_at = step_started(order_id, item_step)
                        replacement_dialog = open_replacement_add_preview(page)
                        saved_part = save_replacement(page, replacement_dialog, part)
                        saved_parts.append(saved_part)
                        step_finished(
                            order_id,
                            item_step,
                            item_started_at,
                            f"数量{part_quantity}",
                        )
                        completed_steps.add(item_step)
                        add_event(
                            order_id,
                            "更换件已保存",
                            f"{saved_part[0]} / {saved_part[1]}",
                        )
                    step_finished(order_id, "保存全部更换配件", part_step, f"共{len(saved_parts)}项")

                    measure = repair_measure_text(order)
                    if "保存维修措施" not in completed_steps:
                        measure_step = step_started(order_id, "保存维修措施")
                        open_fault_mode_edit(page, order)
                        measure = fill_fault_mode_edit(page, order)
                        save_fault_mode_edit(page)
                        add_event(order_id, "维修措施已保存", measure)
                        step_finished(order_id, "保存维修措施", measure_step)
                        completed_steps.add("保存维修措施")
                    else:
                        add_event(order_id, "跳过已完成步骤", "保存维修措施")

                    finish_files = attachment_paths(order, ("完工照片", "完工视频"))
                    if not finish_files:
                        raise RuntimeError("没有找到完工视频或照片")
                    # 与签收附件一致：旧日志不能证明 CRM 真有文件。只有当前
                    # CRM 页面能看到全部文件名，才允许跳过，避免“日志成功、页面空白”。
                    uploaded_finish_files_now = not crm_has_attachments(page, finish_files)
                    if uploaded_finish_files_now:
                        finish_step = step_started(order_id, "上传完工附件")
                        upload_rma_attachments(page, finish_files)
                        step_finished(order_id, "上传完工附件", finish_step, f"共{len(finish_files)}个")
                    else:
                        add_event(order_id, "CRM附件核验通过", "完工照片和视频均已实际存在")

                    preview = SCREENSHOT_DIR / f"{order_id}_completed.png"
                    page.screenshot(path=str(preview), full_page=False)
                    previous_count = int(order.get("CRM已上传附件数") or 0)
                    update_order(
                        order_id,
                        状态=COMPLETED,
                        CRM更换件名称=[part[0] for part in saved_parts],
                        CRM更换件编码=[part[1] for part in saved_parts],
                        CRM维修措施=measure,
                        CRM完工附件数量=len(finish_files),
                        CRM已上传附件数=(
                            previous_count + len(finish_files)
                            if uploaded_finish_files_now
                            else previous_count
                        ),
                        CRM完成截图=str(preview),
                        CRM完成时间=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    )
                    add_event(order_id, "完整维修流程完成", "配件、维修措施和完工附件均已保存")
                    total_elapsed = round(time.monotonic() - workflow_started_at, 1)
                    add_event(order_id, "本次执行耗时", f"{total_elapsed}秒")
                    print(
                        "成功：维修、配件、维修措施和完工附件已一次性完成。"
                        f"维修阶段 {total_elapsed} 秒；"
                        f"Agent总耗时 {round(time.monotonic() - agent_started_at, 1)} 秒。"
                    )
                elif stage == "finish-video-upload":
                    finish_files = attachment_paths(order, ("完工照片", "完工视频"))
                    if not finish_files:
                        raise RuntimeError("没有找到完工视频或照片")
                    upload_rma_attachments(page, finish_files)
                    preview = SCREENSHOT_DIR / f"{order_id}_completed.png"
                    page.screenshot(path=str(preview), full_page=False)
                    previous_count = int(order.get("CRM已上传附件数") or 0)
                    update_order(
                        order_id,
                        状态=COMPLETED,
                        CRM完工附件数量=len(finish_files),
                        CRM已上传附件数=previous_count + len(finish_files),
                        CRM完成截图=str(preview),
                        CRM完成时间=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    )
                    add_event(order_id, "完工附件上传完成", "工单流程已完成")
                    print("成功：师傅端完工视频或照片已上传，FieldDesk工单已完成。")
                elif stage in (
                    "fault-mode-preview",
                    "fault-mode-fill-preview",
                    "fault-mode-fill-save",
                ):
                    open_fault_mode_edit(page, order)
                    measure = None
                    if stage in ("fault-mode-fill-preview", "fault-mode-fill-save"):
                        measure = fill_fault_mode_edit(page, order)
                    if stage == "fault-mode-fill-save":
                        save_fault_mode_edit(page)
                    preview = SCREENSHOT_DIR / f"{order_id}_fault_mode_opened.png"
                    page.screenshot(path=str(preview), full_page=False)
                    update_order(
                        order_id,
                        状态=(
                            CRM_FAULT_MODE_SAVED
                            if stage == "fault-mode-fill-save"
                            else (
                                CRM_FAULT_MODE_FILLED
                                if stage == "fault-mode-fill-preview"
                                else CRM_FAULT_MODE_OPENED
                            )
                        ),
                        CRM故障模式编辑页截图=str(preview),
                        CRM维修页面网址=page.url,
                    )
                    if stage == "fault-mode-fill-save":
                        add_event(order_id, "维修措施已保存", measure)
                        print("成功：维修措施已校验并保存。Agent已暂停。")
                    elif stage == "fault-mode-fill-preview":
                        add_event(order_id, "维修措施已填写", f"{measure}；未保存")
                        print("成功：维修措施已填写。Agent停在保存前。")
                    else:
                        add_event(
                            order_id,
                            "故障模式编辑页已打开",
                            "双击已有数据行；安全暂停；未填写、未保存",
                        )
                        print("成功：已双击故障模式数据行并打开第二页。Agent已暂停。")
                elif stage in ("replacement-add-preview", "replacement-fill-save"):
                    replacement_dialog = None
                    saved_parts = []
                    if stage == "replacement-fill-save":
                        for part in replacement_parts(order):
                            replacement_dialog = open_replacement_add_preview(page)
                            saved_parts.append(save_replacement(page, replacement_dialog, part))
                    else:
                        replacement_dialog = open_replacement_add_preview(page)
                    preview = SCREENSHOT_DIR / f"{order_id}_replacement_add_opened.png"
                    page.screenshot(path=str(preview), full_page=False)
                    update_order(
                        order_id,
                        状态=(
                            CRM_REPLACEMENT_SAVED
                            if stage == "replacement-fill-save"
                            else CRM_REPLACEMENT_ADD_OPENED
                        ),
                        CRM更换件新增截图=str(preview),
                        CRM维修页面网址=page.url,
                    )
                    if stage == "replacement-fill-save":
                        for saved_part in saved_parts:
                            add_event(
                                order_id,
                                "更换件已保存",
                                f"{saved_part[0]} / {saved_part[1]}",
                            )
                        print(f"成功：{len(saved_parts)} 个更换件均已精确匹配并保存，Agent已暂停。")
                    else:
                        add_event(order_id, "更换件新增窗口已打开", "安全暂停；未填写、未保存")
                        print("成功：已打开‘服务单更换件明细-新增’，Agent已暂停。")
                elif stage == "repair-preview":
                    page = click_rma_table_action(page, "维修")
                    preview = SCREENSHOT_DIR / f"{order_id}_repair_opened.png"
                    page.screenshot(path=str(preview), full_page=False)
                    update_order(
                        order_id,
                        状态=CRM_REPAIR_OPENED,
                        CRM维修页面截图=str(preview),
                        CRM维修页面网址=page.url,
                    )
                    add_event(order_id, "已点击维修", "下一页面已打开；安全暂停")
                    print("成功：已点击‘维修’并进入下一页面。Agent已暂停。")
                elif stage in ("detection-preview", "detection-fill-preview", "detection-confirm"):
                    detection_dialog = open_detection_preview(page)
                    if stage in ("detection-fill-preview", "detection-confirm"):
                        fill_detection_preview(page, detection_dialog, order)
                    if stage == "detection-confirm":
                        confirm = detection_dialog.get_by_role(
                            "button", name=re.compile(r"^\s*确认\s*$")
                        )
                        visible_confirm = [
                            confirm.nth(i)
                            for i in range(confirm.count())
                            if confirm.nth(i).is_visible()
                        ]
                        if not visible_confirm:
                            raise RuntimeError("检测窗口没有找到确认按钮")
                        visible_confirm[-1].click(force=True)
                        if not wait_until(
                            lambda: not detection_dialog.is_visible(),
                            timeout_ms=8_000,
                            poll_ms=CHOICE_POLL_MS,
                        ):
                            raise RuntimeError("点击检测确认后，窗口8秒内没有关闭")
                    preview = SCREENSHOT_DIR / f"{order_id}_detection_opened.png"
                    page.screenshot(path=str(preview), full_page=False)
                    update_order(
                        order_id,
                        状态=(
                            CRM_DETECTION_CONFIRMED
                            if stage == "detection-confirm"
                            else CRM_DETECTION_OPENED
                        ),
                        CRM检测窗口截图=str(preview),
                    )
                    if stage == "detection-confirm":
                        add_event(order_id, "检测已确认", "已获得人工批准后执行确认")
                        print("成功：检测结果已确认，准备进入内部维修单阶段。")
                    elif stage == "detection-fill-preview":
                        add_event(order_id, "检测资料已自动填写", "安全暂停；未点击确认")
                        print("成功：检测资料已自动填写。Agent停在确认前，没有提交。")
                    else:
                        add_event(order_id, "检测窗口已打开", "安全暂停；未填写、未确认")
                        print("成功：检测窗口已打开。Agent已安全暂停，没有填写或确认。")
                elif stage == "sign-attachments-upload":
                    paths = attachment_paths(order, ("SN照片", "开箱及外观照片"))
                    sign_upload_step = step_started(order_id, "上传签收附件")
                    upload_rma_attachments(page, paths)
                    step_finished(order_id, "上传签收附件", sign_upload_step, f"共{len(paths)}个")
                    previous_count = int(order.get("CRM已上传附件数") or 0)
                    update_order(
                        order_id,
                        CRM已上传附件数=previous_count + len(paths),
                    )
                    add_event(order_id, "签收附件补传完成", f"共{len(paths)}个")
                    print(f"成功：已补传全部签收照片，共 {len(paths)} 个；没有执行签收或完工。")
                elif stage in ("sign-preview", "sign-only"):
                    # “已经签收”和“签收照片已经上传”是两个独立状态。
                    # 无论本单是否由人工提前签收，都必须把师傅端的 SN/开箱照片
                    # 上传到 CRM；不得因为 stage=sign-only 而假定 CRM 已有照片。
                    paths = attachment_paths(order, ("SN照片", "开箱及外观照片"))
                    # 本地日志可能来自上一次失败或旧页面，不能据此跳过上传。
                    # 只有 CRM 当前页面逐个显示所有文件名时，才算真正完成。
                    crm_already_has_sign_photos = crm_has_attachments(page, paths)
                    if not crm_already_has_sign_photos:
                        sign_upload_step = step_started(order_id, "上传签收附件")
                        upload_rma_attachments(page, paths)
                        step_finished(order_id, "上传签收附件", sign_upload_step, f"共{len(paths)}个")
                        add_event(
                            order_id,
                            "RMA签收附件上传完成",
                            f"SN照片和开箱/外观照片共 {len(paths)} 个；未上传完工照片和视频",
                        )
                    else:
                        add_event(order_id, "CRM附件核验通过", "签收照片均已实际存在，跳过重复上传")
                    if order.get("CRM跳过签收动作"):
                        update_order(
                            order_id,
                            状态="签收照片已上传，人工已签收，等待检测",
                            CRM已上传附件数=(
                                len(paths) if paths else order.get("CRM已上传附件数")
                            ),
                        )
                        add_event(order_id, "跳过签收动作", "照片照常上传；人工已签收")
                        print("成功：SN照片和开箱/外观照片已上传；按设置跳过签收动作。")
                    else:
                        sign_dialog = fill_sign_preview(page, order)
                        if stage == "sign-only":
                            confirm = sign_dialog.get_by_role(
                                "button", name=re.compile(r"^\s*确认\s*$")
                            )
                            visible_confirm = [
                                confirm.nth(index)
                                for index in range(confirm.count())
                                if confirm.nth(index).is_visible()
                            ]
                            if not visible_confirm:
                                raise RuntimeError("签收窗口没有找到确认按钮")
                            visible_confirm[-1].click(force=True)
                            if not wait_until(
                                lambda: not sign_dialog.is_visible(),
                                timeout_ms=5_000,
                            ):
                                raise RuntimeError("点击签收确认后窗口5秒内未关闭")
                        preview = SCREENSHOT_DIR / f"{order_id}_sign_preview.png"
                        page.screenshot(path=str(preview), full_page=False)
                        update_order(
                            order_id,
                            状态=("CRM签收完成，等待检测" if stage == "sign-only" else CRM_SIGN_PREVIEW),
                            CRM签收预览截图=str(preview),
                            CRM已上传附件数=(
                                len(paths) if paths else order.get("CRM已上传附件数")
                            ),
                        )
                        if stage == "sign-only":
                            add_event(order_id, "CRM签收完成", "已核对SN和签收明细并自动确认")
                            print("成功：SN和签收明细已填写，CRM签收已确认。")
                        else:
                            add_event(order_id, "签收资料已准备", "停在签收确认前，未点击确认")
                            print("成功：附件已上传，签收窗口已准备。Agent停在确认前，没有执行签收。")
                else:
                    print("成功：已找到唯一寄修记录并打开 RMA。Agent 已安全暂停，没有签收或提交。")
                    read_rma_info(page)
                result = 0
            except Exception as error:
                evidence = save_failure_evidence(page, order_id)
                update_order(
                    order_id,
                    状态=CRM_FAILED,
                    CRM恢复状态=resume_status,
                    CRM错误=str(error),
                    CRM失败截图=evidence,
                )
                add_event(order_id, "Agent执行失败", str(error))
                print(f"执行失败：{error}")
                result = 2

            # 失败时无论是否传了 --close，都保留现场，避免“闪退”
            # 导致页面和错误线索全部丢失。成功时 --close 仍可正常自动关闭。
            if keep_open or result != 0:
                input("请检查浏览器页面，完成后按回车关闭浏览器……")
            context.close()
            return result
    except Exception as error:
        update_order(order_id, 状态=CRM_FAILED, CRM错误=str(error), CRM失败截图="")
        add_event(order_id, "Agent执行失败", str(error))
        print(f"执行失败：{error}")
        return 2


def main():
    parser = argparse.ArgumentParser(description="FieldDesk 真实 CRM Agent（第一阶段安全版）")
    parser.add_argument("--order", help="指定 FieldDesk 工单编号")
    parser.add_argument(
        "--stage",
        choices=(
            "rma",
            "warranty-confirm",
            "complete-repair",
            "sign-preview",
            "sign-only",
            "sign-attachments-upload",
            "detection-preview",
            "detection-fill-preview",
            "detection-confirm",
            "repair-preview",
            "replacement-add-preview",
            "replacement-fill-save",
            "fault-mode-preview",
            "fault-mode-fill-preview",
            "fault-mode-fill-save",
            "finish-video-upload",
        ),
        default="rma",
        help="执行阶段：打开RMA、上传签收附件、打开检测窗口或自动填写检测预览",
    )
    parser.add_argument("--close", action="store_true", help="成功后直接关闭浏览器")
    args = parser.parse_args()
    sys.exit(run(order_id=args.order, keep_open=not args.close, stage=args.stage))


if __name__ == "__main__":
    main()