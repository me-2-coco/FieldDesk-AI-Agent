from playwright.sync_api import sync_playwright

from agent import CHROME_PROFILE_DIR, CRM_HOME_URL


def main():

    CHROME_PROFILE_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:

        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(CHROME_PROFILE_DIR),
            headless=False,
            channel="chrome",
            viewport={"width": 1440, "height": 900},
        )

        page = context.pages[0] if context.pages else context.new_page()

        page.goto(
            CRM_HOME_URL,
            wait_until="domcontentloaded",
            timeout=60000
        )

        print("请在打开的浏览器中登录CRM。")
        print("确认进入CRM首页后，关闭浏览器即可。")

        input()

        context.close()


if __name__ == "__main__":
    main()