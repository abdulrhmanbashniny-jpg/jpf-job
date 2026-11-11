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

const DEFAULT_COMPANY_LOCATION = {
  hr_whatsapp_phone: '966550000000',
  building_name: 'المقر الرئيسي — شركة رُواء للدهانات والحلول الهندسية',
  address_line: 'طريق الملك عبدالعزيز، حي الشاطئ، جدة',
  floor_number: 'الدور الثالث (3)',
  office_number: 'قاعة الاجتماعات التنفيذية — مكتب 304',
  google_maps_url: 'https://maps.google.com/?q=21.5800,39.1300',
  entrance_image_url: '/img/hq-entrance.svg',
  arrival_instructions: 'يرجى الحضور قبل الموعد بـ 10 دقائق، إبراز بطاقة المقابلة أو الرقم المرجعي لمكتب الاستقبال في الدور الأرضي، علماً بأن مواقف الزوار متاحة أمام البوابة الشمالية.'
};

const DEFAULT_WHATSAPP_TEMPLATES = {
  interview_invite: 'مرحباً {{name}}،\nيسعدنا إبلاغك باجتيازك المرحلة الأولى وتأهلك لمقابلة وظيفة ({{job_title}} - {{job_code}}).\n📅 الموعد: {{date}} الساعة {{time}}\n🎥 نوع المقابلة: عن بُعد (أونلاين)\nرابط بطاقة الموعد والقاعة وتأكيد الحضور:\n{{visit_url}}',
  interview_inperson: 'مرحباً {{name}}،\nيسعدنا إبلاغك باجتيازك المرحلة الأولى وتأهلك لمقابلة حضورية لوظيفة ({{job_title}} - {{job_code}}).\n📅 الموعد: {{date}} الساعة {{time}}\n🏢 المقر: {{building}} — {{floor}} — {{office}}\n📍 بطاقة الوصول وصورة المدخل وموقع قوقل ماب وتأكيد الحضور:\n{{visit_url}}',
  confirm_booking: 'تم تأكيد موعد مقابلتك بنجاح يا {{name}} ✓\nالوظيفة: {{job_title}}\nالموعد: {{date}} الساعة {{time}}\nبطاقة التفاصيل والوصول: {{visit_url}}',
  reminder_day_before: 'تذكير ودي يا {{name}}:\nمقابلتك لوظيفة ({{job_title}}) غداً بتاريخ {{date}} الساعة {{time}}.\nتفاصيل الموعد ورابط الدخول/الموقع: {{visit_url}}\nنتطلع للقائك.',
  send_room_now: 'حان موعد مقابلتك الآن يا {{name}} لوظيفة ({{job_title}}).\nاللجنة بانتظارك عبر الرابط التالي:\n{{meet_url}}',
  thank_followup: 'شكراً لحضورك مقابلة وظيفة ({{job_title}}) يا {{name}}.\nسعدنا بلقائك، وسنوافيك بالقرار النهائي خلال 5 إلى 7 أيام عمل بإذن الله.',
  pass_notification: 'مرحباً أ. {{name}}، تهانينا باجتياز اختبار الجدارة لوظيفة ({{job_title}}) بنسبة {{score}}%. رقم طلبك المرجعي هو {{ref_no}}. سيتواصل معك فريق التوظيف قريباً لتحديد موعد المقابلة.',
  reschedule_notice: 'مرحباً أ. {{name}}، تم تحديث موعد مقابلتك لوظيفة ({{job_title}}) ليصبح يوم {{date}} الساعة {{time}} عبر البطاقة: {{visit_url}}.'
};

/**
 * التحقق من وجود الجداول وتنفيذ الترقيات التلقائية السلسة (v2.1)
 * متطابقة 100% في تعريفات الأعمدة مع database/schema_and_seed.sql وتحافظ على كافة البيانات السابقة
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

    // 1. جدول حسابات اللجنة والصلاحيات (RBAC) مطابق تماماً لـ schema_and_seed.sql
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

    // 2. ترقية الأعمدة التراكمية v2.1 وتوحيد تعريفاتها تماماً مع schema_and_seed.sql
    await client.query(`
      -- candidates.specialization: VARCHAR(150) NOT NULL DEFAULT ''
      ALTER TABLE candidates
        ADD COLUMN IF NOT EXISTS specialization VARCHAR(150) NOT NULL DEFAULT '';
      UPDATE candidates SET specialization = '' WHERE specialization IS NULL;
      ALTER TABLE candidates
        ALTER COLUMN specialization TYPE VARCHAR(150),
        ALTER COLUMN specialization SET DEFAULT '',
        ALTER COLUMN specialization SET NOT NULL;

      -- applications.ai_analysis_status & candidate_access_token
      ALTER TABLE applications
        ADD COLUMN IF NOT EXISTS ai_analysis_status VARCHAR(30) NOT NULL DEFAULT 'completed',
        ADD COLUMN IF NOT EXISTS candidate_access_token VARCHAR(64) NOT NULL DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));
      UPDATE applications SET ai_analysis_status = 'completed' WHERE ai_analysis_status IS NULL;
      UPDATE applications
        SET candidate_access_token = (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
        WHERE candidate_access_token IS NULL OR LENGTH(candidate_access_token) < 32;
      ALTER TABLE applications
        ALTER COLUMN ai_analysis_status TYPE VARCHAR(30),
        ALTER COLUMN ai_analysis_status SET DEFAULT 'completed',
        ALTER COLUMN ai_analysis_status SET NOT NULL,
        ALTER COLUMN candidate_access_token TYPE VARCHAR(64),
        ALTER COLUMN candidate_access_token SET DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
        ALTER COLUMN candidate_access_token SET NOT NULL;

      -- interviews: بيانات المقابلة الحضورية + visit_token غير القابل للتخمين
      ALTER TABLE interviews
        ADD COLUMN IF NOT EXISTS interview_mode VARCHAR(24) NOT NULL DEFAULT 'remote',
        ADD COLUMN IF NOT EXISTS visit_token VARCHAR(64) NOT NULL DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
        ADD COLUMN IF NOT EXISTS location_building VARCHAR(220),
        ADD COLUMN IF NOT EXISTS location_floor VARCHAR(80),
        ADD COLUMN IF NOT EXISTS location_office VARCHAR(80),
        ADD COLUMN IF NOT EXISTS location_maps_url TEXT,
        ADD COLUMN IF NOT EXISTS location_image_url TEXT,
        ADD COLUMN IF NOT EXISTS location_notes TEXT;
      UPDATE interviews SET interview_mode = 'remote' WHERE interview_mode IS NULL;
      UPDATE interviews
        SET visit_token = (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
        WHERE visit_token IS NULL OR LENGTH(visit_token) < 32;
      ALTER TABLE interviews
        ALTER COLUMN interview_mode TYPE VARCHAR(24),
        ALTER COLUMN interview_mode SET DEFAULT 'remote',
        ALTER COLUMN interview_mode SET NOT NULL,
        ALTER COLUMN visit_token TYPE VARCHAR(64),
        ALTER COLUMN visit_token SET DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
        ALTER COLUMN visit_token SET NOT NULL,
        ALTER COLUMN location_building TYPE VARCHAR(220),
        ALTER COLUMN location_floor TYPE VARCHAR(80),
        ALTER COLUMN location_office TYPE VARCHAR(80);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_interviews_visit_token ON interviews (visit_token);

      -- wa_messages.prepared_at: للتمييز بين جاهزة للإرسال / فُتح الرابط كمسودة / تأكد إرسالها فعلياً
      ALTER TABLE wa_messages
        ADD COLUMN IF NOT EXISTS prepared_at TIMESTAMPTZ;

      -- v2.2a: استقبال المرشحين بالـ QR ومؤشر الانضباط الزمني وتنبيه اللجنة اللحظي
      ALTER TABLE interviews
        ADD COLUMN IF NOT EXISTS lobby_status VARCHAR(24) NOT NULL DEFAULT 'not_arrived',
        ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS checked_in_by VARCHAR(120),
        ADD COLUMN IF NOT EXISTS punctuality_minutes INTEGER;
      UPDATE interviews SET lobby_status = 'not_arrived' WHERE lobby_status IS NULL;
      ALTER TABLE interviews
        ALTER COLUMN lobby_status TYPE VARCHAR(24),
        ALTER COLUMN lobby_status SET DEFAULT 'not_arrived',
        ALTER COLUMN lobby_status SET NOT NULL,
        ALTER COLUMN checked_in_by TYPE VARCHAR(120);
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_interviews_lobby_status'
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'interviews'::regclass AND pg_get_constraintdef(oid) LIKE '%lobby_status%'
        ) THEN
          ALTER TABLE interviews
            ADD CONSTRAINT chk_interviews_lobby_status
            CHECK (lobby_status IN ('not_arrived', 'checked_in', 'in_room', 'completed'));
        END IF;
      END $$;

      -- v2.2b: السؤال الصوتي الاختياري (60 ثانية) مع حوكمة الموافقة والمراجعة البشرية والحذف التلقائي بعد 30 يوماً
      ALTER TABLE applications
        ADD COLUMN IF NOT EXISTS voice_pitch_path VARCHAR(350),
        ADD COLUMN IF NOT EXISTS voice_mime_type VARCHAR(80),
        ADD COLUMN IF NOT EXISTS voice_duration_sec INTEGER,
        ADD COLUMN IF NOT EXISTS voice_recorded_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS voice_consent_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS voice_retention_expires_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS voice_purged_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS voice_purge_reason VARCHAR(60),
        ADD COLUMN IF NOT EXISTS voice_bonus_score NUMERIC(4,2) NOT NULL DEFAULT 0.00,
        ADD COLUMN IF NOT EXISTS voice_review_notes TEXT,
        ADD COLUMN IF NOT EXISTS voice_reviewed_by VARCHAR(140),
        ADD COLUMN IF NOT EXISTS voice_reviewed_at TIMESTAMPTZ;
      UPDATE applications SET voice_bonus_score = 0.00 WHERE voice_bonus_score IS NULL;
      ALTER TABLE applications
        ALTER COLUMN voice_pitch_path TYPE VARCHAR(350),
        ALTER COLUMN voice_mime_type TYPE VARCHAR(80),
        ALTER COLUMN voice_purge_reason TYPE VARCHAR(60),
        ALTER COLUMN voice_bonus_score TYPE NUMERIC(4,2),
        ALTER COLUMN voice_bonus_score SET DEFAULT 0.00,
        ALTER COLUMN voice_bonus_score SET NOT NULL,
        ALTER COLUMN voice_reviewed_by TYPE VARCHAR(140);
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_applications_voice_duration'
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'applications'::regclass
            AND pg_get_constraintdef(oid) LIKE '%voice_duration_sec%'
        ) THEN
          ALTER TABLE applications
            ADD CONSTRAINT chk_applications_voice_duration
            CHECK (voice_duration_sec IS NULL OR (voice_duration_sec BETWEEN 1 AND 65));
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_applications_voice_bonus'
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'applications'::regclass
            AND pg_get_constraintdef(oid) LIKE '%voice_bonus_score%'
        ) THEN
          ALTER TABLE applications
            ADD CONSTRAINT chk_applications_voice_bonus
            CHECK (voice_bonus_score BETWEEN 0 AND 5);
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_applications_voice_retention
        ON applications (voice_retention_expires_at)
        WHERE voice_pitch_path IS NOT NULL;

      -- v2.3: بوابة رسائل واتساب التشغيلية عبر WAHA مع قفل Dry-Run الإلزامي ومفتاح الإيقاف الفوري ومنع الرسائل الرجعية
      ALTER TABLE wa_messages
        ADD COLUMN IF NOT EXISTS delivery_channel VARCHAR(30) NOT NULL DEFAULT 'wa_me',
        ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(140),
        ADD COLUMN IF NOT EXISTS external_message_id VARCHAR(140),
        ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS last_error TEXT,
        ADD COLUMN IF NOT EXISTS dry_run_payload JSONB;
      UPDATE wa_messages SET delivery_channel = 'wa_me' WHERE delivery_channel IS NULL;
      UPDATE wa_messages SET attempt_count = 0 WHERE attempt_count IS NULL;
      ALTER TABLE wa_messages
        ALTER COLUMN delivery_channel TYPE VARCHAR(30),
        ALTER COLUMN delivery_channel SET DEFAULT 'wa_me',
        ALTER COLUMN delivery_channel SET NOT NULL,
        ALTER COLUMN idempotency_key TYPE VARCHAR(140),
        ALTER COLUMN external_message_id TYPE VARCHAR(140),
        ALTER COLUMN attempt_count SET DEFAULT 0,
        ALTER COLUMN attempt_count SET NOT NULL;
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_wa_messages_delivery_channel'
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'wa_messages'::regclass
            AND pg_get_constraintdef(oid) LIKE '%delivery_channel%'
        ) THEN
          ALTER TABLE wa_messages
            ADD CONSTRAINT chk_wa_messages_delivery_channel
            CHECK (delivery_channel IN ('wa_me', 'waha_dry_run', 'waha_live', 'wa_me_fallback'));
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_wa_messages_attempt_count'
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'wa_messages'::regclass
            AND pg_get_constraintdef(oid) LIKE '%attempt_count%'
        ) THEN
          ALTER TABLE wa_messages
            ADD CONSTRAINT chk_wa_messages_attempt_count
            CHECK (attempt_count >= 0);
        END IF;
      END $$;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_idempotency_key
        ON wa_messages (idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);

    // 3. إعداد افتراضي لبطاقة المقر الحضورية دون الكتابة فوق أي قيمة موجودة
    await client.query(
      `INSERT INTO system_settings (setting_key, setting_value, category, description, updated_by)
       VALUES ('company_location', $1::jsonb, 'scheduler', 'بيانات مقر المقابلات الحضورية ورقم تواصل واتساب الموارد البشرية', 'system')
       ON CONFLICT (setting_key) DO NOTHING`,
      [JSON.stringify(DEFAULT_COMPANY_LOCATION)]
    );

    // 3B. إعداد افتراضي لبوابة WAHA التشغيلية بوضع Dry-Run الإلزامي ومفتاح الإيقاف الفوري
    await client.query(
      `INSERT INTO system_settings (setting_key, setting_value, category, description, updated_by)
       VALUES ('waha_config', $1::jsonb, 'security_governance', 'حوكمة بوابة WAHA التشغيلية (Dry-Run افتراضي + منع الرسائل الرجعية + مفتاح إيقاف فوري)', 'system')
       ON CONFLICT (setting_key) DO NOTHING`,
      [
        JSON.stringify({
          enabled: false,
          dry_run: true,
          kill_switch_tripped: false,
          waha_activated_at: null,
          max_per_minute: 6,
          max_per_hour: 25
        })
      ]
    );

    // 4. ترقية قوالب واتساب بالدمج الآمن ($1::jsonb || setting_value) بحيث تحتفظ بجميع المفاتيح والقيم الحالية دون حذف أو استبدال
    await client.query(
      `INSERT INTO system_settings (setting_key, setting_value, category, description, updated_by)
       VALUES ('whatsapp_templates', $1::jsonb, 'whatsapp_templates', 'قوالب رسائل واتساب الهجينة للمراحل المعتمدة', 'system')
       ON CONFLICT (setting_key) DO UPDATE
         SET setting_value = $1::jsonb || COALESCE(system_settings.setting_value, '{}'::jsonb)
         WHERE NOT (COALESCE(system_settings.setting_value, '{}'::jsonb) ?& ARRAY[
           'interview_invite',
           'interview_inperson',
           'confirm_booking',
           'reminder_day_before',
           'send_room_now',
           'thank_followup',
           'pass_notification',
           'reschedule_notice'
         ])`,
      [JSON.stringify(DEFAULT_WHATSAPP_TEMPLATES)]
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
  logAudit,
  DEFAULT_COMPANY_LOCATION,
  DEFAULT_WHATSAPP_TEMPLATES
};
