"""Sample real P2604 rows for realistic assistant questions."""
from __future__ import annotations

import json
import os
from pathlib import Path

from dotenv import load_dotenv
import pymysql
from pymysql.cursors import DictCursor

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env", override=False)
load_dotenv(ROOT.parent / "Manage-platform_Agent" / ".env.agents-lan", override=False)

pw = os.getenv("P2604_MYSQL_PASSWORD", "")
conn = pymysql.connect(
    host="192.168.88.99",
    port=3388,
    user="root",
    password=pw,
    database="P2604",
    charset="utf8mb4",
    cursorclass=DictCursor,
    connect_timeout=8,
    read_timeout=20,
)
cur = conn.cursor()
queries = {
    "exams": "SELECT Name, Type, IsOpen, IsClosed FROM Cultivate_Examination LIMIT 10",
    "groups": "SELECT Name, Status, Grade FROM PC_PersonGroup LIMIT 10",
    "group_items": (
        "SELECT g.Name AS gname, i.StudentName, i.StudentCode, i.GameRoleText "
        "FROM PC_PersonGroup g JOIN PC_PersonGroupItem i ON g.PersonGroupId=i.PersonGroupId LIMIT 15"
    ),
    "old": "SELECT Name, Age, Sex, Nursinglevel, RoomId FROM PC_OldPeople LIMIT 10",
    "rooms": "SELECT ID, RoomName FROM Sys_Room LIMIT 10",
    "old_room": (
        "SELECT o.Name, o.Nursinglevel, r.RoomName "
        "FROM PC_OldPeople o LEFT JOIN Sys_Room r ON o.RoomId=r.ID "
        "WHERE r.RoomName IS NOT NULL LIMIT 10"
    ),
    "banks": "SELECT Name, IsOpen, IsEnable FROM PC_QuestionBank LIMIT 10",
    "company": (
        "SELECT c.Name, b.TotalBedSpace, b.TotalArea, b.AddressType "
        "FROM PC_Company c LEFT JOIN PC_CompanyBuild b ON c.CompanyId=b.CompanyId LIMIT 10"
    ),
    "roles": (
        "SELECT u.UserTrueName, u.UserName, r.RoleName "
        "FROM Sys_User u LEFT JOIN Sys_Role r ON u.Role_Id=r.Role_Id LIMIT 12"
    ),
    "exam_users": (
        "SELECT e.Name AS exam, u.StudentTrueName, u.StudentName "
        "FROM Cultivate_Examination e JOIN Cultivate_ExaminationUser u "
        "ON e.ExaminationId=u.ExaminationId LIMIT 12"
    ),
    "bind": (
        "SELECT e.Name AS exam, b.Name AS bank "
        "FROM Cultivate_Examination e "
        "JOIN Cultivate_ExaminationXQuestionBank x ON e.ExaminationId=x.ExaminationId "
        "JOIN PC_QuestionBank b ON x.QuestionBankId=b.QuestionBankId LIMIT 12"
    ),
    "nursing": "SELECT Nursinglevel, COUNT(*) AS c FROM PC_OldPeople GROUP BY Nursinglevel ORDER BY c DESC",
    "signed_n": "SELECT COUNT(*) AS c FROM PC_SignedOldPeople",
    "old_n": "SELECT COUNT(*) AS c FROM PC_OldPeople",
    "students": "SELECT Name, Code, Grade, Class FROM Sys_Student LIMIT 10",
    "questions": (
        "SELECT b.Name AS bank, q.Type, LEFT(IFNULL(q.Description,''), 48) AS d "
        "FROM PC_QuestionBank b JOIN PC_Question q ON b.QuestionBankId=q.QuestionBankId LIMIT 10"
    ),
    "menus": "SELECT MenuName, Url FROM Sys_Menu WHERE MenuName IS NOT NULL AND MenuName<>'' LIMIT 12",
    "depts": "SELECT DepartmentName FROM Sys_Department LIMIT 10",
}
out = {}
for k, sql in queries.items():
    try:
        cur.execute(sql)
        out[k] = list(cur.fetchall() or [])
    except Exception as exc:  # noqa: BLE001
        out[k] = {"error": str(exc)}
conn.close()
Path(ROOT / ".data" / "sample_p2604.json").parent.mkdir(parents=True, exist_ok=True)
Path(ROOT / ".data" / "sample_p2604.json").write_text(
    json.dumps(out, ensure_ascii=False, default=str, indent=2),
    encoding="utf-8",
)
print("ok", {k: (len(v) if isinstance(v, list) else v) for k, v in out.items()})
