# P2604 智慧养老机构运营管理 ERP

默认只读业务表：`PC_*`、`Cultivate_*`。系统辅助表仅：`Sys_Student`、`Sys_User`、`Sys_Role`、`Sys_Menu`、`Sys_Department`、`Sys_Room`、`Sys_Dictionary`、`Sys_DictionaryList`、`Sys_BaseInfo`。
不要查 `Sys_Log`、代码生成表、工作流表，除非用户明确要日志或代码生成。禁止 `UserPwd`。
「目前」不要把 StartTime/EndTime/IsOpen 的 NULL 当成不存在。老人库默认 `PC_OldPeople`；只有说签约/已入住才用 `PC_SignedOldPeople`。
问数量且问分别是什么时，选出名称列，不要只 COUNT。

## 表目录（白名单）

- `Cultivate_Examination` 突发事件。列：ExaminationId, Name（名称）, StartTime（开始时间）, EndTime（结束时间）, Duration（考试时长）, IsOpen（是否开放考试）, IsViewResolution（是否允许查看试题解析）, IsClosed（是否已关闭考卷）
- `Cultivate_ExaminationAnswerRecord` 突发事件答题记录。列：Id, ExaminationId, QuestionId（试题Id）, OperationType（操作类型：（随堂练习：1，模拟考试：2））, UserId, UserName（学生姓名）, ExaminationScore（试题分数）, CorrectScore（得分）, QuestionType（题型）, Description（问题描述）, EnterAnswer（输入答案）, CorrectAnswer（正确答案）
- `Cultivate_ExaminationItem` 突发事件试题。列：ExaminationItemId, ExaminationId, VideoPlaybackDuration, Score（试题分数）, QuestionType（题型：（单选、多选、判断、仿真实验））, QuestionDescription（描述）, QuestionAnalysis（试题解析）, CorrectAnswer（正确答案）
- `Cultivate_ExaminationReport` 。列：Id, ExaminationUserId（考试绑定考生表主键）, ExaminationName（试卷名称）, StartTime（开始时间）, EndTime（结束时间）, Duartion（耗时）, TotalScore（本次得分）, AnswerCount（答题数量）, Times（第几次练习）, StudentId（学生Id）, StudentName（学生姓名）, ExaminationType（试卷类型）, PersonGroupId（团队主键）, PersonGroupName（团队名称）
- `Cultivate_ExaminationUser` 考试学生。列：Id, ExaminationId（考试Id）, StudentId（学生Id）, StudentName（学号）, StudentTrueName（学生姓名）, Duration（考试耗时）, StartTime（开始时间）, EndTime（结束时间）
- `Cultivate_ExaminationXQuestionBank` 题库和突发事件关系对照表。列：ExaminationXQuestionBankId, ExaminationId, QuestionBankId
- `Cultivate_ExperimentalExerciseRecord` 仿真实验练习记录。列：Id, ClientCode（设备编号）, ExperimentalCode（仿真实验编号）, ExperimentalName（仿真实验名称）, ExperimentalId（仿真实验Id）, UserName, UserTrueName, Duration（耗时）, ExerciseProgress（练习进度）, StartTime（开始时间）, EndTime（结束时间）
- `Cultivate_ExperimentalExerciseRecordItem` 虚拟仿真实验记录明显。列：ItemId, StepNumber（步骤号）, StepName（步骤名称）, StepScore（步骤分数）, UserName（用户）, UserTrueName（用户名称）, Id, ExerciseProgress
- `PC_BankInfo` 。列：BankId, Name（银行名称）, LoanType（贷款类型）, AnnualizedRate（年化率）, RepaymentMethod（还款方式）
- `PC_ClassHourRecord` 。列：ClassHourRecordId, UserId（用户Id）, UserName（用户姓名）, ClassTime（上课时间）, ClassBreakTime（下课时间）, SemesterId（学期ID）, Name（学期名）, StartDate（开始时间）, EndDate（结束时间）, Status（课程状态）
- `PC_Company` 养老机构。列：CompanyId, PersonGroupId, Name（机构名称）, ServiceScope（服务范围）, LogoUrl（logo）, Description（企业文化）, Grade（班级）, Income（收入）
- `PC_CompanyBuild` 养老机构建造信息。列：CompanyBuildId, CompanyId, PersonGroupId, AddressType（机构选址）, BuildMethod（服务场所性质）, ItemJson（规模）, TotalBedSpace（共计床位）, TotalArea（总面积）
- `PC_CompanyItem` 。列：CompanyItemId, CompanyId, PersonGroupId, Grade（班级）, Income（收入）, Expenses（支出）, Cash（现金）, Profit（利润）, BrandValue（品牌值）, OperatingCycleDicId（运行周期）, TotalBedSpace（总床位）, Residents（在院人数）, TotalNurse（护理总人数）
- `PC_ElderlyCareStatistics` 老年人口与养老机构统计表。列：ElderlyCareStatisticsId, Year（年份）
- `PC_ElderlyCareStatisticsItem` 老年人口与养老机构统计明细表。列：ElderlyCareStatisticsItemId（主键，自增ID）, Region（区域名称（如和平区、南开区、全市合计））, TotalPopulationOver60（60岁以上总人数，单位：万人）, ActiveSelfCare（活力自理人数，单位：万人）, MildDisability（轻度失能人数，单位：万人）, ModerateDisability（中度失能人数，单位：万人）, SevereDisability（重度失能人数，单位：万人）, CompleteDisability（完全失能人数，单位：万人）, AgingRate（老龄化率，单位：%（如30.12表示30.12%））, NumberOfElderlyInstitutions（养老机构数量，单位：所）, ElderlyCareStatisticsId（主表Id）
- `PC_Info` 数据存储。列：InfoId, PersonGroupId, Class, Grade（年级）, InfoKey（数据类型）, Info（数据Json）, OperatingCycleKey（运营周期）, RoleID（角色）
- `PC_Number` 数值相关（声望值）。列：Id, PersonGroupId, Type（类型（1、声望值））, Number（值）
- `PC_NumberLog` 数值修改记录。列：Id, PersonGroupId, NumberId, SourceValue, TargetValue, Description（描述）
- `PC_OldPeople` 老人库。列：OldPeopleId, Name（姓名）, Age（年龄）, Sex（性别）, Nation（民族）, Phone（电话）, Occupation（职业）, RegionalPreference（地区偏好）, PerformancePreferences（性能偏好）, Nursinglevel（护理级别）, Character（性格）, Assessment1（健康指数）, Assessment2（认知功能）, Assessment3（社交活动）
- `PC_OperatingCycle` 运营周期列表。列：OperatingCycleId, Time（时长）, Status（状态）, Grade（班级）, OperatingCycleKey（当前运营周期）, OperatingCycleValue, OpenStatus（开始状态）, RoundsNum（轮次）
- `PC_OperatingCycleDic` 运营周期字典。列：OperatingCycleDicId, OperatingCycleName（名称）, Grade（班级）
- `PC_OperatingCycleItem` 运营周期明细。列：OperatingCycleItemId, OperatingCycleId, Name（分组名称）, PersonGroupId, Status（状态）
- `PC_PersonGroup` 人员分组。列：PersonGroupId, GroupKey（秘钥）, Name（名称）, IsEnable（是否启用）, Status（状态（1、筹建，2、试运营，3、正式））, Grade（年级）, Class, Round（轮次）
- `PC_PersonGroupItem` 人员分组明细。列：PersonGroupItemId, PersonGroupId, UserId（用户ID）, StudentId（学生ID）, StudentCode（学号）, StudentName（学生姓名）, GameRoleValue（游戏角色value）, GameRoleText（游戏角色）, JobDescription（职责描述）, Salary（薪资）
- `PC_Question` 试题。列：QuestionId, QuestionBankId, Type（题型：（单选、多选、判断、仿真实验））, ExperimentalProgramId, ExperimentalCode, ExperimentalName, Description（描述）, Analysis（试题解析）, CorrectAnswer（正确答案）, Option（选择题选项）, IsEnable
- `PC_QuestionBank` 题库。列：QuestionBankId, Name, GameRole, IsEnable, IsOpen
- `PC_QuestionResource` 题库资源（视频和VR资源）。列：ResourceId, Name（资源名称）, Type（资源分类）, FilePath（文件）, ImgPath（封面图）, ResourceType（视频分类）, Code（资源编码）
- `PC_RegionOverview` 区域养老行业概况主表。列：RegionId（自增主键，对应序号）, AdminDistrict（行政区名称，如：和平区、河东区）, JurisdictionArea（辖区面积（平方公里））, ServiceTarget（可服务对象描述）, MainBuildingConfig（主要建筑配置描述）, AvgBeds（区域养老机构核定平均床位数）, AvgYearlyRent（区域养老机构年均市场租金（万元/年））, LocationPositioning（地段整体定位）, MedicalResourceDesc（周边医疗资源）, RegisteredCareOrgCount（周边已备案养老机构数量（家））, IndustryRemark（备注）, Status（竞拍状态）
- `PC_RegionOverviewItem` 具体地块养老项目明细表。列：RegionItemId（自增主键，地块唯一标识）, RegionId（关联主表RegionOverview的RegionId）, PlotName（地块名称或编号）, TargetDemographic（服务对象）, LandArea（辖区面积/地块面积）, BuildingSpecs（建筑配置）, ApprovedBeds（核定床位数）, MarketRentPrice（市场年均租金）, SitePositioning（地段整体定位）, MedicalResources（医疗资源概况）, CareOrgQuantity（养老机构数量）, PublicTransport（公共交通概况）
- `PC_RegionOverviewItemPersonGroup` 具体地块养老项目明细表和团队对照表。列：RegionOverviewItemId, Id, PersonGroupId, Grade
- `PC_Semester` 教学学期表。列：SemesterId, Name（学期名）, StartDate（开始时间）, EndDate（结束时间）, IsActive（是否当前学期）
- `PC_SignedOldPeople` 已签约老人库。列：OldPeopleId, Id, Name（姓名）, Age（年龄）, Sex（性别）, Nation（民族）, Phone（电话）, Occupation（职业）, RegionalPreference（地区偏好）, PerformancePreferences（性能偏好）, Nursinglevel（护理级别）, Character（性格）, Assessment1（健康指数）, Assessment2（认知功能）
- `PC_SignedTalent` 人才库。列：TalentId, Name（姓名）, Age（年龄）, Sex（性别）, Nation（民族）, Major（专业）, SalaryExpectation（期望薪资）, Salary（薪资）, IsNight（夜班轮岗）, EntryTime（入职时间）, Certificate（资格证书）, Capacity（基础能力）
- `PC_StudentPerformance` 学生表现。列：StudentPerformanceId, StudentId（学生ID）, StudentCode（学号）, StudentName（学生姓名）, UserId（用户ID）, PerformanceScore（表现分）, SemesterId（学期ID）, SemesterName（学期名称）
- `PC_Talent` 人才库。列：TalentId, Name（姓名）, Age（年龄）, Sex（性别）, Nation（民族）, Major（专业）, SalaryExpectation（期望薪资）, Salary（薪资）, IsNight（夜班轮岗）, EntryTime（入职时间）, Certificate（资格证书）, Capacity（基础能力）
- `Sys_BaseInfo` 。列：Id, Type, Digit（数字）, Content（文字描述）, TypeValue（分类）
- `Sys_Department` 。列：DepartmentId, DepartmentName, DepartmentCode, ParentId, DepartmentType, Enable, Remark
- `Sys_Dictionary` 。列：Dic_ID, Config, DBServer, DbSql, DicName, DicNo, Enable, OrderNo
- `Sys_DictionaryList` 。列：DicList_ID, DicName, DicValue, Dic_ID, Enable, OrderNo, Remark
- `Sys_Menu` 。列：Menu_Id, MenuName, Auth, Icon, Description, Enable, OrderNo, TableName, ParentId, Url
- `Sys_Role` 。列：Role_Id, DeleteBy, DeptName, Dept_Id, Enable, OrderNo, ParentId, RoleName
- `Sys_Room` 房间信息表。列：ID（房间ID）, RoomName（房间名）, NormalDecorationCost（普装装修费用）, PremiumDecorationCost（精装费用）, LuxuryDecorationCost（高等装修费用）, RoomArea（房间面积）, NormalRent（普通租金）, PremiumRent（精装租金）, LuxuryRent（高等租金）, NormalImageUrl（普通房间图片地址）, PremiumImageUrl（精装房间图片地址）, LuxuryImageUrl（高等房间图片地址）, RoomScene（房间场景）
- `Sys_Student` 学生档案。列：Id, UserId, Code（学号）, Name（姓名）, Grade（年级）, Class, PhoneNumber（联系电话）, IsEnable（是否启用）
- `Sys_User` 。列：User_Id, Role_Id, RoleName, PhoneNo, Remark, Tel, UserName, UserTrueName, DeptName, Dept_Id, Email, Enable, Gender, HeadImageUrl

## 常用 JOIN

- 突发事件试题/题目/选项：`Cultivate_Examination`, `Cultivate_ExaminationItem`。`Cultivate_Examination.ExaminationId = Cultivate_ExaminationItem.ExaminationId`
- 考试学生/谁参加突发事件：`Cultivate_Examination`, `Cultivate_ExaminationUser`。`Cultivate_Examination.ExaminationId = Cultivate_ExaminationUser.ExaminationId`
- 突发事件绑定题库/绑定了哪些题库/绑题库：`Cultivate_Examination`, `Cultivate_ExaminationXQuestionBank`, `PC_QuestionBank`。`Cultivate_Examination.ExaminationId = Cultivate_ExaminationXQuestionBank.ExaminationId AND Cultivate_ExaminationXQuestionBank.QuestionBankId = PC_QuestionBank.QuestionBankId`
- 题库里的试题/题库试题/哪些试题：`PC_QuestionBank`, `PC_Question`。`PC_QuestionBank.QuestionBankId = PC_Question.QuestionBankId`
- 团队成员/组内学生/分组学生/分组里/各组成员：`PC_PersonGroup`, `PC_PersonGroupItem`。`PC_PersonGroup.PersonGroupId = PC_PersonGroupItem.PersonGroupId`
- 分组学生对照花名册：`PC_PersonGroupItem`, `Sys_Student`。`PC_PersonGroupItem.StudentId = Sys_Student.Id`
- 学生账号/登录名：`Sys_Student`, `Sys_User`。`Sys_Student.UserId = Sys_User.User_Id`
- 用户角色：`Sys_User`, `Sys_Role`。`Sys_User.Role_Id = Sys_Role.Role_Id`
- 老人房间/房号：`PC_OldPeople`, `Sys_Room`。`PC_OldPeople.RoomId = Sys_Room.ID`
- 机构建造/床位：`PC_Company`, `PC_CompanyBuild`。`PC_Company.CompanyId = PC_CompanyBuild.CompanyId`

## 不在默认范围

`FormCollectionObject`、`FormDesignOptions`、`SellOrder`、`SellOrderList`、`Sys_City`、`Sys_CodingRules`、`Sys_Log`、`Sys_Province`、`Sys_QuartzLog`、`Sys_QuartzOptions`、`Sys_RoleAuth`、`Sys_TableColumn`、`Sys_TableInfo`、`Sys_UserDepartment`、`Sys_WorkFlow`、`Sys_WorkFlowStep`、`Sys_WorkFlowTable`、`Sys_WorkFlowTableAuditLog`、`Sys_WorkFlowTableStep`、`TestDb`、`TestService`
