# 突发事件 / 题库

突发事件主表 `Cultivate_Examination`（Name 名称，Type 事件类型：1=文本 2=视频）。
问谁参加/报名必须 JOIN `Cultivate_ExaminationUser`（StudentTrueName 姓名，StudentName 学号）。
绑定题库：`Cultivate_Examination` JOIN `Cultivate_ExaminationXQuestionBank` JOIN `PC_QuestionBank`。
不要用 IsOpen/IsClosed 代替「这场叫什么」。
