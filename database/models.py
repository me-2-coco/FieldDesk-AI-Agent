# FieldDesk AI 数据模型


class RepairTicket:

    def __init__(
        self,
        ticket_id,
        customer,
        device,
        fault
    ):
        self.ticket_id = ticket_id
        self.customer = customer
        self.device = device
        self.fault = fault

        self.status = "WAITING_REVIEW"

        self.ai_result = None


    def update_status(self, status):
        self.status = status


    def save_ai_result(self, result):
        self.ai_result = result


    def show(self):
        return {
            "ticket_id": self.ticket_id,
            "customer": self.customer,
            "device": self.device,
            "fault": self.fault,
            "status": self.status,
            "ai_result": self.ai_result
        }