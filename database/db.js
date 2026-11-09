const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { hashPassword } = require('../services/auth');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn('[DB Warning] لم يتم تعيين DATABASE_URL في متغيرات البيئة. سيتم استخدام الاتصال المحلي الافتراضي.');
}

const pool = new Pool({
  connectionString: connectionString || 'postgresql://postgres:postgres@127.0.0.1:5432/smart_hr_db',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  console.error('[PostgreSQL Unexpected Pool Error]:', err.message);
});

/**
 * التحقق من وجود الجداول وتنفيذ الترقيات التلقائية (بما فيها جدول الصلاحيات staff_users)
 */
async function ensureDatabaseInitialized() {
  const client = await pool.connect();
  try {
    const checkRes = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'jobs'
      ) AS initialized;
    `);

    const isInitialized = checkRes.rows[0]?.initialized === true;
    if (!isInitialized && process.env.AUTO_SEED_DB !== 'false') {
      console.log('[DB Init] جاري تهيئة الجداول والبيانات التأسيسية من schema_and_seed.sql...');
      const sqlPath = path.join(__dirname, 'schema_and_seed.sql');
      const sql = fs.readFileSync(sqlPath, 'utf8');
      await client.query(sql);
      console.log('[DB Init] تمت تهيئة قاعدة البيانات smart_hr_db بنجاح.');
    }

    // ترقية تلقائية متوافقة مع الخوادم العاملة: إنشاء جدول حسابات اللجنة والصلاحيات (RBAC)
    await client.query(`
      CREATE TABLE IF NOT EXISTS staff_users (
        id              SERIAL PRIMARY KEY,
        username        VARCHAR(60) NOT NULL UNIQUE,
        full_name       VARCHAR(150) NOT NULL,
        job_title       VARCHAR(120) NOT NULL DEFAULT 'عضو لجنة التوظيف',
        role            VARCHAR(40) NOT NULL DEFAULT 'committee_member' CHECK (role IN (
                          'super_admin',
                          'committee_member',
                          'hr_coordinator'
                        )),
        password_hash   TEXT NOT NULL,
        is_active       BOOLEAN NOT NULL DEFAULT TRUE,
        last_login_at   TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // إنشاء حساب المدير الرئيسي تلقائياً عند أول تشغيل باستخدام ADMIN_ACCESS_CODE من .env
    const countUsers = await client.query('SELECT COUNT(*)::int AS cnt FROM staff_users');
    if (countUsers.rows[0].cnt === 0) {
      const initialPass = process.env.ADMIN_ACCESS_CODE || 'RUWAA-HR-2026';
      const pwdHash = hashPassword(initialPass);
      await client.query(
        `INSERT INTO staff_users (username, full_name, job_title, role, password_hash, is_active)
         VALUES ($1, $2, $3, 'super_admin', $4, TRUE)`,
        ['admin', 'مدير النظام ورئيس اللجنة', 'المدير التنفيذي للموارد البشرية', pwdHash]
      );
      console.log('[RBAC Init] تم تفعيل حساب المدير الافتراضي (username: admin) بكلمة المرور المعرّفة في ADMIN_ACCESS_CODE داخل .env');
    }
  } finally {
    client.release();
  }
}

/**
 * تسجيل حدث في جدول سجل التدقيق والحوكمة (audit_logs)
 */
async function logAudit({
  actor = 'النظام',
  actorRole = 'system',
  action,
  entityType,
  entityId = null,
  metadata = {},
  ipAddress = null
}) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (actor, actor_role, action, entity_type, entity_id, metadata, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [actor, actorRole, action, entityType, entityId ? String(entityId) : null, JSON.stringify(metadata), ipAddress]
    );
  } catch (err) {
    console.error('[Audit Log Error]:', err.message);
  }
}

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  ensureDatabaseInitialized,
  logAudit
};
