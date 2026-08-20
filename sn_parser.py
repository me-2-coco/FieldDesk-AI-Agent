def parse_sn(sn):

    # 前6位项目编码
    code6 = sn[:6]

    # 第6位如果是0，匹配厂家表时使用前5位
    if code6[5] == "0":
        match_code = code6[:5]
    else:
        match_code = code6

    # 第7、8位生产日期
    year_code = sn[6]
    month_code = sn[7].upper()
    month_map = {"A": 10, "B": 11, "C": 12}
    production_month = month_map.get(month_code, int(month_code) if month_code.isdigit() and month_code != "0" else None)

    return {
        "SN": sn,
        "项目编码": code6,
        "匹配编码": match_code,
        "生产年份": year_code + "年",
        "生产月份": f"{production_month}月" if production_month else "未知"
    }
