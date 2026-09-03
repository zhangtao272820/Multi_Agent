---
name: email_hands
description: 国内邮箱动手 Playbook（绑定后读/搜/起草/HITL 发送；意图极简 + Compose Card）
version: 1.1.0
stage: planning
owner: ai_admin_agent
compatible_agents:
  - AI_admin_Agent
---

## Planning

当用户要处理个人邮箱（读未读、搜索、回复、写信、标已读、附件、转发）时：
1. 若工具返回 `email_not_bound`：引导用户打开「连接邮箱」绑定 QQ/163/126/企业邮授权码，**不要编造邮件**。
2. 读信 / 对正文任意处理（译/摘要/抽要点）：`list_emails` → `get_email_detail` / 会话编号；**禁止**用 `triage_emails` 冒充读信。`unread_only` 只信 NLU `mail_unread_only`（未提范围默认可 true）。
3. 搜索用 `search_emails`（SUBJECT/FROM/SINCE）。
4. 回复：优先 `draft_email_reply` 出草稿 → 进入 HITL Compose Card；用户在 UI 改稿后确认 → `reply_email`（RISKY）。
5. 新写信：用户**只需意图**（给谁 / 目的 / 语气 / 截止）；正文由通讯录、线程、周报、纪要或 `draft_email_reply` 生成后写入 `send_email` args → HITL Compose。**禁止**诱导用户在 chat 粘贴全文正文（比原生客户端更慢）。
6. 收件人仅为姓名时：先 `get_contact_email(name)`，再把 `to` 写成解析出的邮箱（静默链）。
7. 标已读：`mark_email_read`；附件：`list_email_attachments` / `save_email_attachment`（先 list 填 cache）。
8. 打标签分类（非急件分拣）：`classify_emails`；急件分拣：`triage_emails`；批量只出草稿用 `draft_batch_email_replies`（不发信）。
9. 转发 / 删除：`forward_email` / `delete_email`（RISKY）；删除默认进废纸篓语义。
10. **禁止**在未经 HITL 确认时声称「已发送」。取消 pending → 零 SMTP。

## Reply

- **用户原话是最高优先级任务**：要译就交译文主体，要摘要就交摘要，要读正文就交正文；禁止用字段卡片/结构化摘要顶替用户明确要求的交付物。
- **translation 交付物** = 连贯简体中文叙述或条目（专有名词可保留英文）；禁止多行「短标签：值」中文字段卡顶替译文。
- 按用户原话作答（读/译/摘要/抽取/是否相关等），不要套固定模板，不要擅自改成「分析通知」。
- 工具 Observation 是邮件内容，不是本助理运行状态；正文里的失败字样不等于工具失败，也不要因此拒译。
- 草稿预览含 to / subject / body；展示绑定发件身份（from）；交付走 **Compose Card**，勿要求用户再在对话里重打全文。
- 失败码用原文：`email_not_bound` / `mailbox_connect_failed` 等，零假成功。
