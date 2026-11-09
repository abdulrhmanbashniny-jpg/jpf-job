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
 * التحقق من وجود الجداول وتنفيذ الترقيات التلقائية السلسة (v2.1) دون مسح أي بيانات حالية
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

    // 1. جدول حسابات اللجنة والصلاحيات (RBAC)
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

    const countUsers = await client.query('SELECT COUNT(*)::int AS cnt FROM staff_users');
    if (countUsers.rows[0].cnt === 0) {
      const initialPass = process.env.ADMIN_ACCESS_CODE || 'RUWAA-HR-2026';
      const pwdHash = hashPassword(initialPass);
      await client.query(
        `INSERT INTO staff_users (username, full_name, job_title, role, password_hash, is_active)
         VALUES ($1, $2, $3, 'super_admin', $4, TRUE)`,
        ['admin', 'مدير النظام ورئيس اللجنة', 'المدير التنفيذي للموارد البشرية', pwdHash]
      );
      console.log('[RBAC Init] تم تفعيل حساب المدير الافتراضي (username: admin)');
    }

    // 2. ترقية v2.1: فصل المؤهل العلمي عن التخصص + حالة التحليل الذكي غير المتزامن + بيانات المقابلة الحضورية
    await client.query(`
      ALTER TABLE candidates
        ADD COLUMN IF NOT EXISTS specialization VARCHAR(150) NOT NULL DEFAULT '';

      ALTER TABLE applications
        ADD COLUMN IF NOT EXISTS ai_analysis_status VARCHAR(30) NOT NULL DEFAULT 'completed';

      ALTER TABLE interviews
        ADD COLUMN IF NOT EXISTS interview_mode VARCHAR(20) NOT NULL DEFAULT 'remote',
        ADD COLUMN IF NOT EXISTS location_building VARCHAR(220),
        ADD COLUMN IF NOT EXISTS location_floor VARCHAR(80),
        ADD COLUMN IF NOT EXISTS location_office VARCHAR(80),
        ADD COLUMN IF NOT EXISTS location_maps_url TEXT,
        ADD COLUMN IF NOT EXISTS location_image_url TEXT,
        ADD COLUMN IF NOT EXISTS location_notes TEXT;
    `);

    // 3. إعداد افتراضي لبطاقة المقر الحضوري ورقم واتساب الموارد البشرية (للطلبات الفورية)
    await client.query(
      `INSERT INTO system_settings (setting_key, setting_value, category, description)
       VALUES ($1, $2::jsonb, 'scheduler', 'بيانات مقر المقابلات الحضورية ورقم تواصل واتساب الموارد البشرية')
       ON CONFLICT (setting_key) DO NOTHING`,
      [
        'company_location',
        JSON.stringify({
          hr_whatsapp_phone: '966550000000',
          building_name: 'المقر الرئيسي — شركة رُواء للدهانات والحلول الهندسية',
          address_line: 'طريق الملك عبدالعزيز، حي الشاطئ، جدة',
          floor_number: 'الدور الثالث (3)',
          office_number: 'قاعة الاجتماعات التنفيذية — مكتب 304',
          google_maps_url: 'https://maps.google.com/?q=21.5800,39.1300',
          entrance_image_url: '/img/hq-entrance.svg',
          arrival_instructions: 'يرجى الحضور قبل الموعد بـ 10 دقائق، إبراز بطاقة المقابلة أو الرقم المرجعي لمكتب الاستقبال في الدور الأرضي، علماً بأن مواقف الزوار متاحة أمام البوابة الشمالية.'
        })
      ]
    );

    // 4. ترقية قوالب واتساب الخمسة (عن بُعد + حضوري + تأكيد + تذكير + قاعة/شكر) مع الحفاظ على التعديلات السابقة
    const tplRes = await client.query("SELECT setting_value FROM system_settings WHERE setting_key = 'whatsapp_templates'");
    const currTpl = tplRes.rows[0]?.setting_value || {};
    const upgradedTemplates = {
      interview_invite: currTpl.interview_invite || 'مرحباً {{name}}،\nيسعدنا إبلاغك باجتيازك المرحلة الأولى وتأهلك لمقابلة وظيفة ({{job_title}} - {{job_code}}).\n📅 الموعد: {{date}} الساعة {{time}}\n🎥 نوع المقابلة: عن بُعد (أونلاين)\nرابط القاعة الافتراضية وتأكيد الحضور:\n{{visit_url}}',
      interview_inperson: currTpl.interview_inperson || 'مرحباً {{name}}،\nيسعدنا إبلاغك باجتيازك المرحلة الأولى وتأهلك لمقابلة حضورية لوظيفة ({{job_title}} - {{job_code}}).\n📅 الموعد: {{date}} الساعة {{time}}\n🏢 المقر: {{building}} — {{floor}} — {{office}}\n📍 بطاقة الوصول وصورة المدخل وموقع قوقل ماب وتأكيد الحضور:\n{{visit_url}}',
      confirm_booking: currTpl.confirm_booking || 'تم تأكيد موعد مقابلتك بنجاح يا {{name}} ✓\nالوظيفة: {{job_title}}\nالموعد: {{date}} الساعة {{time}}\nبطاقة التفاصيل والوصول: {{visit_url}}',
      reminder_day_before: currTpl.reminder_day_before || 'تذكير ودي يا {{name}}:\nمقابلتك لوظيفة ({{job_title}}) غداً بتاريخ {{date}} الساعة {{time}}.\nتفاصيل الموعد ورابط الدخول/الموقع: {{visit_url}}\nنتطلع للقائك.',
      send_room_now: currTpl.send_room_now || 'حان موعد مقابلتك الآن يا {{name}} لوظيفة ({{job_title}}).\nاللجنة بانتظارك عبر الرابط التالي:\n{{meet_url}}',
      thank_followup: currTpl.thank_followup || 'شكراً لحضورك مقابلة وظيفة ({{job_title}}) يا {{name}}.\nسعدنا بلقائك، وسنوافيك بالقرار النهائي خلال 5 إلى 7 أيام عمل بإذن الله.'
    };

    await client.query(
      `INSERT INTO system_settings (setting_key, setting_value, category, description)
       VALUES ('whatsapp_templates', $1::jsonb, 'whatsapp_templates', 'قوالب رسائل واتساب الهجينة للمراحل الخمس')
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1::jsonb`,
      [JSON.stringify(upgradedTemplates)]
    );
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
