import json
import re
from pathlib import Path


MAPPING_FILE = Path(__file__).resolve().parent / "knowledge" / "sn_model_mapping.json"


def infer_model_from_sn(sn):
    """用 SN 开头的项目编码匹配机型；无法唯一判断时不自动猜测。"""
    normalized_sn = re.sub(r"[^A-Z0-9]", "", str(sn or "").upper())
    result = {
        "sn": normalized_sn,
        "status": "not_found",
        "project_code": "",
        "machine_model": "",
        "product_line": "",
        "candidates": [],
    }
    if not normalized_sn or not MAPPING_FILE.exists():
        return result

    try:
        records = json.loads(MAPPING_FILE.read_text(encoding="utf-8")).get("records", [])
    except (OSError, ValueError, TypeError):
        return result

    matches = []
    for record in records:
        project_code = re.sub(
            r"[^A-Z0-9]", "", str(record.get("project_code") or "").upper()
        )
        if project_code and normalized_sn.startswith(project_code):
            matches.append({**record, "project_code": project_code})

    if not matches:
        return result

    longest = max(len(item["project_code"]) for item in matches)
    matches = [item for item in matches if len(item["project_code"]) == longest]
    candidates = []
    seen = set()
    for item in matches:
        key = (item.get("machine_model", ""), item.get("product_line", ""))
        if key not in seen:
            candidates.append(item)
            seen.add(key)

    result["project_code"] = candidates[0]["project_code"]
    result["candidates"] = [item.get("machine_model", "") for item in candidates]
    if len(candidates) == 1:
        result.update({
            "status": "matched",
            "machine_model": candidates[0].get("machine_model", ""),
            "product_line": candidates[0].get("product_line", ""),
        })
    else:
        result["status"] = "ambiguous"
    return result
