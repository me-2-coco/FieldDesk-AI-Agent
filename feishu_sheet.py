import os
from urllib.parse import quote

import requests


APP_ID = os.getenv("FEISHU_APP_ID")
APP_SECRET = os.getenv("FEISHU_APP_SECRET")

SPREADSHEET_TOKEN = "HSCCspGdth0vNAt73x6c68wNnkh"
SHEET_ID = "0MdgGt"


def get_tenant_access_token() -> str:
    if not APP_ID or not APP_SECRET:
        raise RuntimeError(
            "没有设置 FEISHU_APP_ID 或 FEISHU_APP_SECRET"
        )

    url = (
        "https://open.feishu.cn/open-apis/"
        "auth/v3/tenant_access_token/internal"
    )

    response = requests.post(
        url,
        json={
            "app_id": APP_ID,
            "app_secret": APP_SECRET,
        },
        timeout=20,
    )
    response.raise_for_status()

    result = response.json()

    if result.get("code") != 0:
        raise RuntimeError(f"获取飞书凭证失败：{result}")

    return result["tenant_access_token"]


def read_factory_sheet():
    token = get_tenant_access_token()

    # 读取 A 到 G 列，先读取前5000行
    cell_range = f"{SHEET_ID}!A1:G5000"
    encoded_range = quote(cell_range, safe="")

    url = (
        "https://open.feishu.cn/open-apis/sheets/v2/"
        f"spreadsheets/{SPREADSHEET_TOKEN}/values/{encoded_range}"
    )

    response = requests.get(
        url,
        headers={
            "Authorization": f"Bearer {token}",
        },
        timeout=30,
    )
    response.raise_for_status()

    result = response.json()

    if result.get("code") != 0:
        raise RuntimeError(f"读取厂家表失败：{result}")

    return result["data"]["valueRange"]["values"]
def get_factory_models():
    return read_factory_sheet()

if __name__ == "__main__":
    rows = read_factory_sheet()

    print(f"成功读取 {len(rows)} 行")
    print("前10行数据：")

    for row in rows[:10]:
        print(row)
