# 分组学生

分组主表 `PC_PersonGroup`，成员 `PC_PersonGroupItem`。
JOIN：`PC_PersonGroup.PersonGroupId = PC_PersonGroupItem.PersonGroupId`。
对照花名册再 JOIN `Sys_Student`（`PersonGroupItem.StudentId = Sys_Student.Id`）。
问各组人数用 GROUP BY 组名；问某组有谁必须带组名过滤或列出组名列。
口语「二层组 / 二战组 / 某组有谁 / 组里都有谁」一律映射本技能表。
成员名单：`PC_PersonGroup.Name` 模糊或等值过滤后 JOIN `PC_PersonGroupItem` 列出 StudentName/StudentCode；不要澄清、不要只回组名列表。
