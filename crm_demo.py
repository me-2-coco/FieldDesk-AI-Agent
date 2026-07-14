import streamlit as st


st.set_page_config(
    page_title="FieldDesk CRM",
    layout="centered"
)


st.title("🏢 FieldDesk CRM")


st.divider()


phone = st.text_input(
    "客户电话"
)


sn = st.text_input(
    "SN码"
)


fault = st.text_area(
    "故障描述"
)


parts = st.text_input(
    "更换配件"
)



if st.button("提交维修工单"):

    st.success(
        "CRM工单提交成功"
    )


    st.write(
        "客户电话:",
        phone
    )

    st.write(
        "SN:",
        sn
    )

    st.write(
        "故障:",
        fault
    )

    st.write(
        "配件:",
        parts
    )