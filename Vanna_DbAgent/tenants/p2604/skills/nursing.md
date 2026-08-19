# 老人护理

默认查 `PC_OldPeople`（老人库）。只有用户明确说签约/已入住才用 `PC_SignedOldPeople`。
护理级别列：`Nursinglevel`。问「各护理级别多少人」必须 GROUP BY 该列。
名单选出姓名、年龄、护理级别；不要主键和审计列。
