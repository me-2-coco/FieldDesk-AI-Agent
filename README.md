# FieldDesk AI Agent

第一版目标：师傅提交完整维修资料，内勤审核后，Agent 使用客户已登录的 CRM 会话进入“扫码签收”，查询唯一寄修记录并打开 RMA，然后安全暂停等待人工确认。

真实 CRM 扫码签收入口：

```text
https://crm2.recloud.com.cn/t/dreame/webapp/dreame/?mainNavName=serviceprovider#/scanSignin/query
```

## 安装

```bash
python3 -m pip install -r requirements.txt
python3 -m playwright install chromium
```

## 运行顺序

### 1. 启动师傅端

```bash
streamlit run technician_app.py --server.port 8501
```

### 2. 启动内勤审核端

```bash
streamlit run admin_app.py --server.port 8502
```

### 3. 客户本人登录 CRM 并保存会话

```bash
python crm_login.py
```

程序只保存浏览器登录会话，不在代码中保存账号密码。登录会话失效后重新运行即可。

### 4. 运行真实 CRM Agent

```bash
python agent.py
```

也可以指定工单：

```bash
python agent.py --order FD20260714123456
```

上传附件并准备签收预览（不会点击确认）：

```bash
python agent.py --order FD20260714123456 --stage sign-preview
```

## 安全边界

- 第一版只查询并打开 RMA。
- `sign-preview` 会上传附件并填写签收窗口，但不会点击确认。
- RMA签收阶段只上传“SN照片”和“开箱及外观照片”。
- “完工照片”和“完工视频”保留到内部维修单的最后完工阶段上传。
- 不点击签收、完工或最终提交。
- 查询不到或出现多条记录时立即停止。
- 成功后保留浏览器，等待人工检查并按回车关闭。
- CRM 截图和登录会话保存在 `runtime/`，不提交到代码仓库。
