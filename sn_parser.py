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
    month_code = sn[7]

    return {
        "SN": sn,
        "项目编码": code6,
        "匹配编码": match_code,
        "生产年份": year_code + "年",
        "生产月份": month_code + "月"
    }
