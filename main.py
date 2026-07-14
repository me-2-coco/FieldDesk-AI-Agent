from fastapi import FastAPI
from sn_parser import parse_sn
from pydantic import BaseModel

app = FastAPI()


@app.get("/")
def home():
    return {
        "system": "FieldDesk AI Agent",
        "status": "running"
    }


# 师傅维修提交数据
class RepairSubmit(BaseModel):
    sn: str
    fault: str
    parts: list[str]
    description: str
    warranty: str


# 接收维修资料
@app.post("/repair/submit")
def repair_submit(data: RepairSubmit):

    # 根据SN判断产品
    if data.sn.startswith("W"):
        product_type = "洗地机"

    elif data.sn.startswith("R"):
        product_type = "扫地机"

    else:
        product_type = "未知产品"


    return {
        "SN": data.sn,
        "产品类型": product_type,
        "用户报修": data.fault,
        "更换配件": data.parts,
        "维修描述": data.description,
        "保修状态": data.warranty,
        "AI判断":fault_ai(data.fault,data.parts)
    }
def fault_ai(fault, parts):

    text = fault + " ".join(parts)


    if "充电" in text or "电池" in text:
        return {
            "故障分类1": "产品质量",
            "故障分类2": "无法充电/充不进去电",
            "故障分类3": "电池包不良"
        }


    if "漏水" in text:
        return {
            "故障分类1": "产品质量",
            "故障分类2": "漏水",
            "故障分类3": "水箱异常"
        }


    return {
        "故障分类1": "待判断",
        "故障分类2": "待判断",
        "故障分类3": "待判断"
    }
@app.post("/sn/check")
def check_sn(data: dict):

    sn = data["sn"]

    result = parse_sn(sn)

    return result
