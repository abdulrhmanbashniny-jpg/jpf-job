const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
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
 * التحقق من وجود الجداول وتطبيق ملف schema_and_seed.sql تلقائياً عند الحاجة
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
