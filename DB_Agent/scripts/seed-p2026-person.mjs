/**
 * p2026 人员主表 + 健康档案 + 紧急联系人 灌数（龙奶奶/林爷爷/张三/河西区性别分布等）
 * 用法：node scripts/seed-p2026-person.mjs
 * 环境：MYSQL_PASSWORD（默认 123456），库名 p2026
 */
import mysql from 'mysql2/promise'

const cfg = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '123456',
  database: process.env.MYSQL_DATABASE || 'p2026',
}

const TENANT = 1
const NOW = new Date()

/** @type {{ name: string; gender: 1|2; age: number; region: string; address?: string; liveId?: number; crowdId?: number }[]} */
const PERSONS = [
  { name: '龙奶奶', gender: 2, age: 75, region: '天津市河西区', address: '河西区陈塘庄街道幸福里001号' },
  { name: '林爷爷', gender: 1, age: 72, region: '天津市南开区', address: '南开区学府街道康乐里002号' },
  { name: '张三', gender: 1, age: 68, region: '天津市河东区', address: '河东区大直沽街道003号' },
  { name: '测试5', gender: 1, age: 70, region: '天津市和平区', address: '和平区劝业场004号' },
  { name: '陈明宇', gender: 1, age: 65, region: '天津市河西区', address: '河西区友谊路005号' },
  { name: '林婉清', gender: 2, age: 63, region: '天津市河西区', address: '河西区友谊路006号' },
  { name: '张明宇', gender: 1, age: 22, region: '天津市河西区', address: '河西区体院北007号' },
  { name: '王建国', gender: 1, age: 67, region: '天津市河北区', address: '河北区王串场008号' },
  { name: '陈子墨', gender: 1, age: 58, region: '天津市河西区', address: '河西区广东路009号' },
  // 河西区 70–79 岁：5 男 2 女（性别分布用例）
  { name: '赵大爷', gender: 1, age: 71, region: '天津市河西区', address: '河西区下瓦房010号' },
  { name: '钱爷爷', gender: 1, age: 73, region: '天津市河西区', address: '河西区下瓦房011号' },
  { name: '孙伯伯', gender: 1, age: 76, region: '天津市河西区', address: '河西区挂甲寺012号' },
  { name: '周叔叔', gender: 1, age: 78, region: '天津市河西区', address: '河西区挂甲寺013号' },
  { name: '吴爷爷', gender: 1, age: 79, region: '天津市河西区', address: '河西区马场014号' },
  { name: '郑奶奶', gender: 2, age: 74, region: '天津市河西区', address: '河西区马场015号' },
  { name: '冯阿姨', gender: 2, age: 77, region: '天津市南开区', address: '南开区鼓楼016号' },
  // 天津市其它区 + 独居
  { name: '李奶奶', gender: 2, age: 81, region: '天津市滨海新区', address: '滨海新区塘沽017号', liveId: 1 },
  { name: '刘爷爷', gender: 1, age: 69, region: '天津市', address: '天津市红桥区018号', liveId: 2 },
]

/** @type {{ name: string; health: Record<string, string|number> }} */
const HEALTH = [
  { name: '龙奶奶', health: { systolic_pressure: '135', diastolic_pressure: '85', heart_rate: '72', blood_glucose: '5.8' } },
  { name: '林爷爷', health: { systolic_pressure: '130', diastolic_pressure: '85', heart_rate: '68', blood_glucose: '5.4' } },
  { name: '张三', health: { systolic_pressure: '128', diastolic_pressure: '82', heart_rate: '75', blood_glucose: '5.6', blood_oxygen: '98' } },
  { name: '测试5', health: { systolic_pressure: '110', diastolic_pressure: '120', heart_rate: '70' } },
  { name: '陈明宇', health: { systolic_pressure: '122', diastolic_pressure: '78', heart_rate: '66' } },
  { name: '林婉清', health: { systolic_pressure: '118', diastolic_pressure: '76', heart_rate: '64' } },
  { name: '张明宇', health: { systolic_pressure: '120', diastolic_pressure: '80', heart_rate: '72' } },
  { name: '王建国', health: { systolic_pressure: '125', diastolic_pressure: '80', heart_rate: '70' } },
  { name: '陈子墨', health: { systolic_pressure: '115', diastolic_pressure: '75', heart_rate: '68' } },
]

/** 18 位测试身份证号（仅本地 seed，非真实证件） */
function fakeIdCard(index, gender, birthday) {
  const y = birthday.getFullYear()
  const m = String(birthday.getMonth() + 1).padStart(2, '0')
  const d = String(birthday.getDate()).padStart(2, '0')
  const seq = String(index).padStart(3, '0')
  const check = gender === 2 ? String((index * 2) % 10) : String((index * 2 + 1) % 10)
  return `120103${y}${m}${d}${seq}${check}`
}

async function main() {
  const c = await mysql.createConnection(cfg)
  console.log('[seed] database', cfg.database)

  await c.query('SET FOREIGN_KEY_CHECKS=0')
  await c.query('TRUNCATE TABLE person_emergency_contact')
  await c.query('TRUNCATE TABLE person_health_records')
  await c.query('TRUNCATE TABLE person_selfcare_conditions')
  await c.query('TRUNCATE TABLE person_info')
  await c.query('TRUNCATE TABLE person_live_conditions')
  await c.query('TRUNCATE TABLE person_crowd_type')
  await c.query('SET FOREIGN_KEY_CHECKS=1')

  await c.query(
    `INSERT INTO person_live_conditions (id, name, create_time, update_time, deleted, tenant_id) VALUES
     (1, '独居', ?, ?, 0, ?),
     (2, '与子女同住', ?, ?, 0, ?)`,
    [NOW, NOW, TENANT, NOW, NOW, TENANT],
  )
  await c.query(
    `INSERT INTO person_crowd_type (id, name, create_time, update_time, deleted, tenant_id) VALUES
     (1, '一般老人', ?, ?, 0, ?),
     (2, '重点关爱', ?, ?, 0, ?)`,
    [NOW, NOW, TENANT, NOW, NOW, TENANT],
  )
  await c.query(
    `INSERT INTO person_selfcare_conditions (id, name, create_time, update_time, deleted, tenant_id) VALUES
     (1, '完全自理', ?, ?, 0, ?),
     (2, '部分自理', ?, ?, 0, ?)`,
    [NOW, NOW, TENANT, NOW, NOW, TENANT],
  )

  const idByName = new Map()
  let idx = 0
  for (const p of PERSONS) {
    idx += 1
    const birthday = new Date(NOW.getFullYear() - p.age, 5, 15)
    const [res] = await c.query(
      `INSERT INTO person_info
       (name, is_gender, age, phone, birthday, id_card_no, address, provinces_and_cities,
        live_conditions_id, crowd_type_id, selfcare_conditions_id, create_time, update_time, deleted, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        p.name,
        p.gender,
        p.age,
        `138${String(Math.floor(Math.random() * 90000000 + 10000000))}`,
        birthday,
        fakeIdCard(idx, p.gender, birthday),
        p.address || p.region,
        p.region,
        p.liveId ?? 2,
        p.crowdId ?? 1,
        1,
        NOW,
        NOW,
        TENANT,
      ],
    )
    idByName.set(p.name, res.insertId)
  }

  for (const h of HEALTH) {
    const pid = idByName.get(h.name)
    if (!pid) continue
    const cols = ['person_id', 'create_time', 'update_time', 'deleted', 'tenant_id']
    const vals = [pid, NOW, NOW, 0, TENANT]
    for (const [k, v] of Object.entries(h.health)) {
      cols.push(k)
      vals.push(String(v))
    }
    await c.query(
      `INSERT INTO person_health_records (${cols.map((x) => '`' + x + '`').join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      vals,
    )
  }

  const ecPairs = [
    ['龙奶奶', '龙小明', '13900001001'],
    ['林爷爷', '林强', '13900001002'],
    ['李奶奶', '李小红', '13900001003'],
  ]
  for (const [pname, cname, phone] of ecPairs) {
    const pid = idByName.get(pname)
    if (!pid) continue
    await c.query(
      `INSERT INTO person_emergency_contact
       (person_id, alarmer_id, concat_name_first, concat_phone_first, create_time, update_time, deleted, tenant_id)
       VALUES (?, 0, ?, ?, ?, ?, 0, ?)`,
      [pid, cname, phone, NOW, NOW, TENANT],
    )
  }

  // A3：林婉清足底压力检测 3 次（remote_activity_foot_log）
  const footTable = 'remote_activity_foot_log'
  const [footTables] = await c.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1`,
    [cfg.database, footTable],
  )
  let footSeeded = 0
  if (Array.isArray(footTables) && footTables.length) {
    const [cols] = await c.query(
      `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY, EXTRA
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [cfg.database, footTable],
    )
    const colSet = new Set((cols || []).map((r) => String(r.COLUMN_NAME || '')))
    const nameCol = ['person_name', 'name', 'elder_name', 'oldman_name', 'patient_name'].find((x) =>
      colSet.has(x),
    )
    if (nameCol) {
      // 幂等：先清该人名旧种子再插入 3 条
      await c.query(`DELETE FROM \`${footTable}\` WHERE \`${nameCol}\` = ? OR \`${nameCol}\` LIKE ?`, [
        '林婉清',
        '%林婉清%',
      ])
      const idMeta = (cols || []).find((r) => String(r.COLUMN_NAME) === 'id')
      const idAuto = idMeta && /auto_increment/i.test(String(idMeta.EXTRA || ''))
      let nextId = 0
      if (idMeta && !idAuto) {
        const [[mx]] = await c.query(`SELECT COALESCE(MAX(id), 0) AS m FROM \`${footTable}\``)
        nextId = Number(mx?.m || 0)
      }
      for (let i = 0; i < 3; i++) {
        const fields = [nameCol]
        const values = ['林婉清']
        if (idMeta && !idAuto) {
          nextId += 1
          fields.unshift('id')
          values.unshift(nextId)
        }
        if (colSet.has('deleted')) {
          fields.push('deleted')
          values.push(0)
        }
        if (colSet.has('tenant_id')) {
          fields.push('tenant_id')
          values.push(TENANT)
        }
        if (colSet.has('create_time')) {
          fields.push('create_time')
          values.push(new Date(NOW.getTime() - i * 86400000))
        }
        if (colSet.has('update_time')) {
          fields.push('update_time')
          values.push(NOW)
        }
        // create_by / update_by 在本库多为整型用户 id，勿写入字符串
        const byMeta = (cols || []).find((r) => String(r.COLUMN_NAME) === 'create_by')
        if (byMeta && /int|decimal|double|float|bigint/i.test(String(byMeta.DATA_TYPE || ''))) {
          fields.push('create_by')
          values.push(0)
        }
        await c.query(
          `INSERT INTO \`${footTable}\` (${fields.map((x) => '`' + x + '`').join(', ')}) VALUES (${fields
            .map(() => '?')
            .join(', ')})`,
          values,
        )
        footSeeded += 1
      }
    } else {
      console.warn('[seed] foot table exists but no name column; skip foot seed')
    }
  } else {
    console.warn('[seed] table remote_activity_foot_log missing; skip foot seed')
  }

  const [[pi]] = await c.query('SELECT COUNT(*) c FROM person_info WHERE deleted=0')
  const [[ph]] = await c.query('SELECT COUNT(*) c FROM person_health_records WHERE deleted=0')
  const [[ec]] = await c.query('SELECT COUNT(*) c FROM person_emergency_contact WHERE deleted=0')
  const [hexiRows] = await c.query(
    `SELECT is_gender, COUNT(*) c FROM person_info WHERE deleted=0 AND provinces_and_cities LIKE '%河西区%' AND age BETWEEN 70 AND 79 GROUP BY is_gender`,
  )

  console.log('[seed] person_info active:', pi.c)
  console.log('[seed] person_health_records:', ph.c)
  console.log('[seed] person_emergency_contact:', ec.c)
  console.log('[seed] 河西区70-79性别:', hexiRows)
  console.log('[seed] remote_activity_foot_log 林婉清 rows:', footSeeded)

  await c.end()
  console.log('[seed] OK')
}

main().catch((e) => {
  console.error('[seed] FAIL', e)
  process.exit(1)
})
