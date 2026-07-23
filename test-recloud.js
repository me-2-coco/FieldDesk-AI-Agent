const {
    openRecloud,
    saveLogin,
    scanSign,
    getRepairDetail,
    confirmSign
} = require("./connectors/recloud");



async function main(){


    // ==============================
    // 打开瑞云
    // ==============================

    const {
        browser,
        context,
        page
    } = await openRecloud();



    // ==============================
    // 第一次运行需要登录
    // 登录后保存
    // ==============================

    await page.waitForTimeout(
        5000
    );


    await saveLogin(
        context
    );



    // ==============================
    // 物流单号
    // ==============================

    const logisticsNo =
        String(
            process.env.RECLOUD_TEST_LOGISTICS_NO || ""
        ).trim();

    if (!logisticsNo) {
        throw new Error(
            "请通过 RECLOUD_TEST_LOGISTICS_NO 提供联调物流单号"
        );
    }



    console.log(
        "开始查询:",
        logisticsNo
    );



    await scanSign(
        page,
        logisticsNo
    );



    // ==============================
    // 获取RMA信息
    // ==============================


    const detail =
        await getRepairDetail(
            page
        );



    console.log(
        "RMA信息:"
    );


    console.log(
        detail
    );



    // ==============================
    // 自动签收
    // ==============================


    const result =
        await confirmSign(
            page,

            detail.sn,

            detail.productType
        );



    console.log(
        result
    );



    // 不关闭浏览器
    // 方便观察结果

}



main()
.catch(
    err=>{

        console.error(
            err
        );

    }
);
