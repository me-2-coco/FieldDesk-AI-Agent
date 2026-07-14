from playwright.sync_api import sync_playwright

from agent import CRM_HOME_URL, SESSION_FILE


def main():
    SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=False)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()
        page.goto(CRM_HOME_URL, wait_until="domcontentloaded", timeout=60000)

        print("请在打开的浏览器中由客户本人登录CRM。")
        print("确认已经看到CRM首页后，回到这里按回车。")
        input()

        context.storage_state(path=str(SESSION_FILE))
        browser.close()

    print(f"CRM登录会话已保存：{SESSION_FILE}")
    print("程序没有保存账号和密码；会话失效后重新运行本程序即可。")


if __name__ == "__main__":
    main()
