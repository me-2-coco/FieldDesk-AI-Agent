from agents.repair_agent import RepairAgent
from database.models import RepairTicket
from shared.status import AI_ANALYZING, COMPLETED


def main():

    # 创建维修工单
    ticket = RepairTicket(
        ticket_id="FD-001",
        customer="测试用户",
        device="扫地机器人",
        fault="无法开机"
    )


    print("当前工单:")
    print(ticket.show())


    # AI开始分析
    ticket.update_status(AI_ANALYZING)


    agent = RepairAgent()


    result = agent.analyze({
        "fault": ticket.fault
    })


    # 保存AI结果
    ticket.save_ai_result(result)

    ticket.update_status(COMPLETED)


    print("\nAI分析完成:")
    print(ticket.show())


if __name__ == "__main__":
    main()