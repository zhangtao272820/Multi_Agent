---
name: email_hands
description: 国内邮箱动手 Playbook（绑定后读/搜/起草/HITL 发送）
version: 1.0.0
stage: planning
owner: ai_admin_agent
compatible_agents:
  - AI_admin_Agent
---

## Planning

当用户要处理个人邮箱（读未读、搜索、回复、写信、标已读、附件、转发）时：
1. 若工具返回 `email_not_bound`：引导用户打开「连接邮箱」绑定 QQ/163/126/企业邮授权码，**不要编造邮件**。
2. 读信：`list_emails` → `get_email_detail` / 会话编号；搜索用 `search_emails`（SUBJECT/FROM/SINCE）。
3. 回复：优先 `draft_email_reply` 出草稿 → 用户确认后 `reply_email`（RISKY / HITL）。
4. 新写信：`send_email`（RISKY）；收件人可为通讯录 **或** 用户明确给出的合法邮箱；禁止默默捏造地址。
5. 标已读：`mark_email_read`；附件：`list_email_attachments` / `save_email_attachment`。
6. 转发 / 删除：`forward_email` / `delete_email`（RISKY）；删除默认进废纸篓语义。
7. **禁止**在未经 HITL 确认时声称「已发送」。取消 pending → 零 SMTP。

## Reply

- 展示绑定发件身份（from）。
- 草稿预览含 to / subject / body。
- 失败码用原文：`email_not_bound` / `mailbox_connect_failed` 等，零假成功。
