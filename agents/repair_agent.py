class RepairAgent:
    """
    FieldDesk AI 维修智能 Agent
    """

    def __init__(self):
        self.name = "Repair Agent"

    def analyze(self, ticket):
        """
        分析维修工单
        """

        fault = ticket.get("fault", "")

        result = {
            "agent": self.name,
            "fault": fault,
            "inspection": [],
            "next_action": ""
        }

        if "不开机" in fault:
            result["inspection"] = [
                "检查电源",
                "检查主板供电",
                "检查电池状态"
            ]
            result["next_action"] = "WAITING_TECHNICIAN"

        elif "噪音" in fault:
            result["inspection"] = [
                "检查风扇",
                "检查机械结构"
            ]
            result["next_action"] = "CHECK_HARDWARE"

        else:
            result["inspection"] = [
                "人工检测"
            ]
            result["next_action"] = "MANUAL_REVIEW"

        return result