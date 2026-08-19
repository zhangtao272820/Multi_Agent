# P2604 智慧养老机构运营管理 ERP

默认只读业务表：`PC_*`、`Cultivate_*`。系统辅助表仅：`Sys_Student`、`Sys_User`、`Sys_Role`、`Sys_Menu`、`Sys_Department`、`Sys_Room`、`Sys_Dictionary`、`Sys_DictionaryList`、`Sys_BaseInfo`。
不要查 `Sys_Log`、代码生成表、工作流表，除非用户明确要日志或代码生成。禁止 `UserPwd`。
「目前」不要把 StartTime/EndTime/IsOpen 的 NULL 当成不存在。老人库默认 `PC_OldPeople`；只有说签约/已入住才用 `PC_SignedOldPeople`。
问数量且问分别是什么时，选出名称列，不要只 COUNT。
