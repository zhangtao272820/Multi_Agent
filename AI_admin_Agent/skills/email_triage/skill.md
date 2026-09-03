---
name: email_triage
description: 国内办公邮件分拣 Playbook（可接批量草稿）
version: 1.1.0
stage: planning
owner: ai_admin_agent
compatible_agents:
  - AI_admin_Agent
---

## Planning

当用户要处理收件箱、未读邮件、急件分拣时：
1. **优先**调用 `triage_emails`（先 list 再 classify）。
2. 用户要「帮我起草回复 / 批量草稿」：对需立即处理项用 `draft_batch_email_replies`（只出 Compose，不发）。
3. 对「工作/通知」类高优先级邮件，可建议用户 `add_task` 跟进，但不要自动创建待办除非用户明确要求。
4. 未绑定邮箱时返回 `email_not_bound`：引导「连接邮箱」，不要编造邮件内容。

## Reply

输出：
- **需立即处理**（工作类、带截止）
- **可稍后**（通知、FYI）
- **可忽略**（广告/营销）
禁止泄露邮件 technical id 或 IMAP 细节（可用会话短编号）。

## 话术模板

- 「分拣未读」→ `triage_emails`
- 「急件都起草回复」→ triage 后 `draft_batch_email_replies`
