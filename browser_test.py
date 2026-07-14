from playwright.sync_api import sync_playwright


with sync_playwright() as p:

    browser = p.chromium.launch(
        headless=False
    )

    page = browser.new_page()

    page.goto("https://www.baidu.com")

    print("浏览器打开成功")

    input("按回车关闭浏览器...")