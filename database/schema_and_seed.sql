-- =================================================================================
-- منصة التوظيف الذكية (Smart Recruitment Platform) — رُواء للدهانات والكفاءات الهندسية
-- قاعدة البيانات: smart_hr_db (PostgreSQL 15 / 16 / 17+)
-- يشمل: الجداول، العلاقات (Foreign Keys)، القيود (Constraints)، الدوال التلقائية (Triggers)،
--       الفهارس (Indexes)، والبيانات التأسيسية الكاملة الجاهزة للإنتاج.
-- =================================================================================

BEGIN;

SET client_encoding = 'UTF8';
SET timezone = 'Asia/Riyadh';

-- ---------------------------------------------------------------------------------
-- 1. جدول الإعدادات العامة للنظام (system_settings)
-- ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_settings (
    setting_key     VARCHAR(100) PRIMARY KEY,
    setting_value   JSONB NOT NULL,
    category        VARCHAR(50) NOT NULL CHECK (category IN (
                        'ai_provider',
                        'scoring_weights',
                        'scheduler',
                        'whatsapp_templates',
                        'security_governance'
                    )),
    description     TEXT,
    updated_by      VARCHAR(120) NOT NULL DEFAULT 'system',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------------
-- 2. جدول سجل التدقيق والحوكمة (audit_logs)
-- ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id              BIGSERIAL PRIMARY KEY,
    actor           VARCHAR(120) NOT NULL,
    actor_role      VARCHAR(80) NOT NULL DEFAULT 'system',
    action          VARCHAR(100) NOT NULL,
    entity_type     VARCHAR(60) NOT NULL,
    entity_id       VARCHAR(60),
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address      VARCHAR(64),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs (entity_type, entity_id);

-- ---------------------------------------------------------------------------------
-- 2-ب. جدول حسابات أعضاء اللجنة والصلاحيات (staff_users — RBAC)
-- ---------------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------------
-- 3. جدول الوظائف وبرومنتات الذكاء الاصطناعي وأسئلة الجدارة (jobs)
-- ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
    id                  SERIAL PRIMARY KEY,
    code                VARCHAR(20) NOT NULL UNIQUE,
    title               VARCHAR(180) NOT NULL,
    department          VARCHAR(60) NOT NULL CHECK (department IN (
                            'الإنتاج',
                            'المشاريع',
                            'المبيعات',
                            'الجودة',
                            'المستودعات'
                        )),
    location            VARCHAR(120) NOT NULL DEFAULT 'جدة، المملكة العربية السعودية',
    employment_type     VARCHAR(50) NOT NULL DEFAULT 'دوام كامل',
    experience_level    VARCHAR(80) NOT NULL DEFAULT 'متوسط الخبرة (2 - 5 سنوات)',
    salary_range        VARCHAR(80) NOT NULL DEFAULT 'يُحدد بعد المقابلة + عمولات',
    accent_color        VARCHAR(16) NOT NULL DEFAULT '#C8553D',
    summary             TEXT NOT NULL,
    description         TEXT NOT NULL,
    responsibilities    JSONB NOT NULL DEFAULT '[]'::jsonb,
    requirements        JSONB NOT NULL DEFAULT '[]'::jsonb,
    ai_prompt           TEXT NOT NULL,
    passing_score       NUMERIC(5,2) NOT NULL DEFAULT 60.00 CHECK (passing_score BETWEEN 0 AND 100),
    duration_minutes    INTEGER NOT NULL DEFAULT 20 CHECK (duration_minutes BETWEEN 5 AND 120),
    questions           JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_department_active ON jobs (department, is_active);

-- ---------------------------------------------------------------------------------
-- 4. جدول سجل المتقدمين الموحد لمنع التكرار (candidates)
-- ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS candidates (
    id                  SERIAL PRIMARY KEY,
    full_name           VARCHAR(160) NOT NULL,
    email               VARCHAR(180) NOT NULL UNIQUE,
    phone               VARCHAR(30) NOT NULL UNIQUE,
    city                VARCHAR(100) NOT NULL DEFAULT 'جدة',
    years_experience    NUMERIC(4,1) NOT NULL DEFAULT 0 CHECK (years_experience >= 0 AND years_experience <= 50),
    qualification       VARCHAR(120) NOT NULL DEFAULT 'بكالوريوس',
    specialization      VARCHAR(150) NOT NULL DEFAULT '',
    portfolio_url       TEXT,
    cv_filename         VARCHAR(255),
    cv_stored_path      TEXT,
    cv_extracted_text   TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_candidates_email ON candidates (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_candidates_phone ON candidates (phone);

-- ---------------------------------------------------------------------------------
-- 5. جدول طلبات التوظيف ودرجات التحليل الذكي (applications)
-- ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS applications (
    id                      SERIAL PRIMARY KEY,
    reference_no            VARCHAR(32) NOT NULL UNIQUE,
    job_id                  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
    candidate_id            INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    status                  VARCHAR(40) NOT NULL DEFAULT 'assessment_pending' CHECK (status IN (
                                'assessment_pending',
                                'passed_assessment',
                                'failed_assessment',
                                'under_review',
                                'interview_scheduled',
                                'interviewed',
                                'offered',
                                'rejected'
                            )),
    cv_match_score          NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (cv_match_score BETWEEN 0 AND 100),
    assessment_score        NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (assessment_score BETWEEN 0 AND 100),
    ai_overall_score        NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (ai_overall_score BETWEEN 0 AND 100),
    committee_avg_score     NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (committee_avg_score BETWEEN 0 AND 100),
    final_weighted_score    NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (final_weighted_score BETWEEN 0 AND 100),
    integrity_score         NUMERIC(5,2) NOT NULL DEFAULT 100.00 CHECK (integrity_score BETWEEN 0 AND 100),
    tab_switches            INTEGER NOT NULL DEFAULT 0 CHECK (tab_switches >= 0),
    paste_attempts          INTEGER NOT NULL DEFAULT 0 CHECK (paste_attempts >= 0),
    time_spent_seconds      INTEGER NOT NULL DEFAULT 0 CHECK (time_spent_seconds >= 0),
    ai_report               JSONB NOT NULL DEFAULT '{}'::jsonb,
    ai_analysis_status      VARCHAR(30) NOT NULL DEFAULT 'completed',
    candidate_access_token  VARCHAR(64) NOT NULL DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
    voice_pitch_path        VARCHAR(350),
    voice_mime_type         VARCHAR(80),
    voice_duration_sec      INTEGER CHECK (voice_duration_sec IS NULL OR (voice_duration_sec BETWEEN 1 AND 65)),
    voice_recorded_at       TIMESTAMPTZ,
    voice_consent_at        TIMESTAMPTZ,
    voice_retention_expires_at TIMESTAMPTZ,
    voice_purged_at         TIMESTAMPTZ,
    voice_purge_reason      VARCHAR(60),
    voice_bonus_score       NUMERIC(4,2) NOT NULL DEFAULT 0.00 CHECK (voice_bonus_score BETWEEN 0 AND 5),
    voice_review_notes      TEXT,
    voice_reviewed_by       VARCHAR(140),
    voice_reviewed_at       TIMESTAMPTZ,
    privacy_consent         BOOLEAN NOT NULL DEFAULT TRUE CHECK (privacy_consent = TRUE),
    submitted_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assessed_at             TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_job_candidate UNIQUE (job_id, candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_applications_job_status ON applications (job_id, status);
CREATE INDEX IF NOT EXISTS idx_applications_weighted_score ON applications (final_weighted_score DESC);
CREATE INDEX IF NOT EXISTS idx_applications_submitted_at ON applications (submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_applications_voice_retention ON applications (voice_retention_expires_at) WHERE voice_pitch_path IS NOT NULL;

-- ---------------------------------------------------------------------------------
-- 6. جدول تفاصيل إجابات اختبار الجدارة (assessment_answers)
-- ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assessment_answers (
    id                  SERIAL PRIMARY KEY,
    application_id      INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    question_index      INTEGER NOT NULL CHECK (question_index BETWEEN 1 AND 20),
    question_type       VARCHAR(20) NOT NULL CHECK (question_type IN ('mcq', 'text', 'numeric', 'portfolio')),
    question_text       TEXT NOT NULL,
    answer_value        TEXT,
    attachment_path     TEXT,
    max_points          NUMERIC(5,2) NOT NULL DEFAULT 10.00 CHECK (max_points > 0),
    awarded_points      NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (awarded_points >= 0),
    ai_feedback         TEXT,
    time_taken_seconds  INTEGER NOT NULL DEFAULT 0 CHECK (time_taken_seconds >= 0),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_app_question UNIQUE (application_id, question_index),
    CONSTRAINT chk_awarded_le_max CHECK (awarded_points <= max_points)
);

CREATE INDEX IF NOT EXISTS idx_assessment_answers_app ON assessment_answers (application_id, question_index);

-- ---------------------------------------------------------------------------------
-- 7. جدول تقييمات أعضاء لجنة التوظيف بخمسة معايير موزونة (committee_evaluations)
-- الأوزان الداخلية للمعايير الخمسة:
-- 25% الكفاءة التخصصية + 20% التواصل والإقناع + 20% حل المشكلات + 15% الملاءمة المؤسسية + 20% الخبرة العملية/الأعمال
-- ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS committee_evaluations (
    id                          SERIAL PRIMARY KEY,
    application_id              INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    evaluator_name              VARCHAR(120) NOT NULL,
    evaluator_role              VARCHAR(120) NOT NULL DEFAULT 'عضو لجنة التوظيف',
    technical_competence        NUMERIC(3,1) NOT NULL CHECK (technical_competence BETWEEN 1.0 AND 5.0),
    communication_persuasion    NUMERIC(3,1) NOT NULL CHECK (communication_persuasion BETWEEN 1.0 AND 5.0),
    problem_solving             NUMERIC(3,1) NOT NULL CHECK (problem_solving BETWEEN 1.0 AND 5.0),
    cultural_fit                NUMERIC(3,1) NOT NULL CHECK (cultural_fit BETWEEN 1.0 AND 5.0),
    portfolio_practical         NUMERIC(3,1) NOT NULL CHECK (portfolio_practical BETWEEN 1.0 AND 5.0),
    total_percentage            NUMERIC(5,2) GENERATED ALWAYS AS (
                                    ROUND(
                                        ((technical_competence * 0.25 +
                                          communication_persuasion * 0.20 +
                                          problem_solving * 0.20 +
                                          cultural_fit * 0.15 +
                                          portfolio_practical * 0.20) / 5.0) * 100.0,
                                    2)
                                ) STORED,
    recommendation              VARCHAR(30) NOT NULL DEFAULT 'hire' CHECK (recommendation IN (
                                    'strong_hire',
                                    'hire',
                                    'hold',
                                    'no_hire'
                                )),
    notes                       TEXT,
    evaluated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_app_evaluator UNIQUE (application_id, evaluator_name)
);

CREATE INDEX IF NOT EXISTS idx_committee_eval_app ON committee_evaluations (application_id);

-- ---------------------------------------------------------------------------------
-- 8. جدول جدولة المقابلات وروابط القاعات الافتراضية (interviews)
-- ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interviews (
    id                  SERIAL PRIMARY KEY,
    application_id      INTEGER NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
    scheduled_date      DATE NOT NULL,
    start_time          TIME NOT NULL,
    end_time            TIME NOT NULL,
    duration_minutes    INTEGER NOT NULL DEFAULT 30 CHECK (duration_minutes BETWEEN 15 AND 120),
    meeting_platform    VARCHAR(50) NOT NULL DEFAULT 'Google Meet',
    meeting_url         TEXT NOT NULL,
    interview_mode      VARCHAR(24) NOT NULL DEFAULT 'remote',
    visit_token         VARCHAR(64) NOT NULL DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
    location_building   VARCHAR(220),
    location_floor      VARCHAR(80),
    location_office     VARCHAR(80),
    location_maps_url   TEXT,
    location_image_url  TEXT,
    location_notes      TEXT,
    interviewer_panel   VARCHAR(255) NOT NULL DEFAULT 'لجنة التوظيف والاختيار المركزية',
    booking_status      VARCHAR(30) NOT NULL DEFAULT 'scheduled' CHECK (booking_status IN (
                            'scheduled',
                            'invitation_sent',
                            'confirmed',
                            'completed',
                            'rescheduled',
                            'cancelled',
                            'no_show'
                        )),
    lobby_status        VARCHAR(24) NOT NULL DEFAULT 'not_arrived' CHECK (lobby_status IN (
                            'not_arrived',
                            'checked_in',
                            'in_room',
                            'completed'
                        )),
    checked_in_at       TIMESTAMPTZ,
    checked_in_by       VARCHAR(120),
    punctuality_minutes INTEGER,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_interview_time CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_interviews_date_time ON interviews (scheduled_date, start_time);
CREATE UNIQUE INDEX IF NOT EXISTS idx_interviews_visit_token ON interviews (visit_token);

-- ---------------------------------------------------------------------------------
-- 9. جدول طابور رسائل واتساب الهجينة (wa_messages)
-- ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wa_messages (
    id                  SERIAL PRIMARY KEY,
    application_id      INTEGER REFERENCES applications(id) ON DELETE CASCADE,
    interview_id        INTEGER REFERENCES interviews(id) ON DELETE SET NULL,
    template_key        VARCHAR(50) NOT NULL DEFAULT 'interview_invite',
    recipient_name      VARCHAR(160) NOT NULL,
    recipient_phone     VARCHAR(30) NOT NULL,
    message_body        TEXT NOT NULL,
    wa_link             TEXT NOT NULL,
    queue_status        VARCHAR(30) NOT NULL DEFAULT 'queued' CHECK (queue_status IN (
                            'queued',
                            'sent',
                            'confirmed',
                            'failed',
                            'cancelled'
                        )),
    sent_by             VARCHAR(120),
    delivery_channel    VARCHAR(30) NOT NULL DEFAULT 'wa_me' CHECK (delivery_channel IN (
                            'wa_me',
                            'waha_dry_run',
                            'waha_live',
                            'wa_me_fallback'
                        )),
    idempotency_key     VARCHAR(140),
    external_message_id VARCHAR(140),
    attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_attempt_at     TIMESTAMPTZ,
    last_error          TEXT,
    dry_run_payload     JSONB,
    prepared_at         TIMESTAMPTZ,
    sent_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_status ON wa_messages (queue_status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_idempotency_key ON wa_messages (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- =================================================================================
-- الدوال والمحفزات الذكية (PostgreSQL Functions & Triggers)
-- إعادة حساب متوسط تقييم اللجنة والدرجة النهائية الموزونة تلقائياً (40% AI + 60% لجنة)
-- =================================================================================

CREATE OR REPLACE FUNCTION fn_sync_application_weighted_score(target_app_id INTEGER)
RETURNS VOID AS $$
DECLARE
    v_ai_weight NUMERIC(5,2) := 40.00;
    v_comm_weight NUMERIC(5,2) := 60.00;
    v_weights JSONB;
    v_comm_avg NUMERIC(5,2);
    v_eval_count INTEGER;
    v_ai_score NUMERIC(5,2);
    v_final NUMERIC(5,2);
BEGIN
    SELECT setting_value INTO v_weights
    FROM system_settings
    WHERE setting_key = 'ranking_weights';

    IF v_weights IS NOT NULL THEN
        v_ai_weight := COALESCE((v_weights->>'ai_weight')::NUMERIC, 40.00);
        v_comm_weight := COALESCE((v_weights->>'committee_weight')::NUMERIC, 60.00);
    END IF;

    SELECT COUNT(*), COALESCE(ROUND(AVG(total_percentage), 2), 0.00)
    INTO v_eval_count, v_comm_avg
    FROM committee_evaluations
    WHERE application_id = target_app_id;

    SELECT COALESCE(ai_overall_score, 0.00)
    INTO v_ai_score
    FROM applications
    WHERE id = target_app_id;

    IF v_eval_count > 0 THEN
        v_final := ROUND((v_ai_score * (v_ai_weight / 100.0)) + (v_comm_avg * (v_comm_weight / 100.0)), 2);
    ELSE
        -- إذا لم يتم تقييم اللجنة بعد، تظهر مساهمة الـ AI المبدئية لحين استكمال تقييم اللجنة
        v_final := ROUND(v_ai_score * (v_ai_weight / 100.0), 2);
    END IF;

    UPDATE applications
    SET committee_avg_score = v_comm_avg,
        final_weighted_score = v_final,
        updated_at = NOW()
    WHERE id = target_app_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_fn_after_committee_eval()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM fn_sync_application_weighted_score(OLD.application_id);
        RETURN OLD;
    ELSE
        PERFORM fn_sync_application_weighted_score(NEW.application_id);
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_committee_eval_sync ON committee_evaluations;
CREATE TRIGGER trg_committee_eval_sync
AFTER INSERT OR UPDATE OR DELETE ON committee_evaluations
FOR EACH ROW EXECUTE FUNCTION trg_fn_after_committee_eval();

-- =================================================================================
-- البيانات التأسيسية (Seed Data) — إعدادات النظام + الوظائف + المرشحون + المقابلات
-- =================================================================================

-- 1. إعدادات النظام الافتراضية
INSERT INTO system_settings (setting_key, setting_value, category, description, updated_by)
VALUES
(
    'ai_engine_config',
    '{
        "active_provider": "smart-rubric",
        "model_name": "gpt-4o-mini",
        "temperature": 0.2,
        "blind_screening": true,
        "anonymize_pii": true,
        "cv_weight_in_ai": 30,
        "assessment_weight_in_ai": 70,
        "integrity_penalty_per_switch": 4,
        "integrity_penalty_per_paste": 5
    }'::jsonb,
    'ai_provider',
    'إعدادات محرك التحليل بالذكاء الاصطناعي والفحص الأعمى لمنع التحيز',
    'المدير التنفيذي للموارد البشرية'
),
(
    'ranking_weights',
    '{
        "ai_weight": 40,
        "committee_weight": 60,
        "passing_threshold": 60
    }'::jsonb,
    'scoring_weights',
    'أوزان الترتيب النهائي للمرشحين (40% ذكاء اصطناعي + 60% لجنة التوظيف)',
    'رئيس لجنة التوظيف'
),
(
    'scheduler_config',
    '{
        "work_start": "09:00",
        "work_end": "16:00",
        "slot_duration_minutes": 30,
        "buffer_minutes": 10,
        "dhuhr_break_start": "12:00",
        "dhuhr_break_end": "12:45",
        "default_platform": "Google Meet",
        "meet_base_url": "https://meet.google.com",
        "panel_name": "لجنة التوظيف والاختيار — شركة رُواء للدهانات"
    }'::jsonb,
    'scheduler',
    'ضوابط الجدولة الذكية للمقابلات مع استثناء وقت صلاة الظهر تلقائياً',
    'منسق الاستقطاب'
),
(
    'whatsapp_templates',
    '{
        "interview_invite": "السلام عليكم أ. {{name}}،\nنبارك لك اجتياز التقييم الأولي لوظيفة ({{job_title}} - {{job_code}}) لدى شركة رُواء للدهانات والكفاءات الهندسية.\n\nيسعدنا دعوتك للمقابلة الشخصية مع لجنة التوظيف:\n📅 التاريخ: {{date}}\n⏰ الوقت: {{time}}\n🔗 رابط قاعة Google Meet: {{meet_url}}\n\nنرجو الرد بكلمة (تأكيد) لاعتماد الموعد. مع تمنياتنا لك بالتوفيق.",
        "pass_notification": "مرحباً أ. {{name}}، تهانينا باجتياز اختبار الجدارة لوظيفة ({{job_title}}) بنسبة {{score}}%. رقم طلبك المرجعي هو {{ref_no}}. سيتواصل معك فريق التوظيف قريباً لتحديد موعد المقابلة.",
        "reschedule_notice": "مرحباً أ. {{name}}، تم تحديث موعد مقابلتك لوظيفة ({{job_title}}) ليصبح يوم {{date}} الساعة {{time}} عبر الرابط: {{meet_url}}."
    }'::jsonb,
    'whatsapp_templates',
    'قوالب رسائل واتساب الهجينة الجاهزة للإرسال عبر wa.me',
    'منسق الاستقطاب'
),
(
    'governance_policy',
    '{
        "store_keys_in_browser": false,
        "require_privacy_consent": true,
        "retention_days": 365,
        "max_upload_mb": 10,
        "allowed_extensions": [".pdf", ".docx", ".doc", ".png", ".jpg", ".jpeg"]
    }'::jsonb,
    'security_governance',
    'سياسة الحوكمة وأمن المعلومات وحماية بيانات المتقدمين',
    'مسؤول أمن المعلومات'
)
ON CONFLICT (setting_key) DO NOTHING;

-- 2. الوظائف المتاحة (5 وظائف متكاملة في قطاع الدهانات والصناعات الإبداعية والهندسية)
INSERT INTO jobs (
    code, title, department, location, employment_type, experience_level, salary_range,
    accent_color, summary, description, responsibilities, requirements, ai_prompt,
    passing_score, duration_minutes, questions, is_active
)
VALUES
-- الوظيفة الأولى (الرئيسية المطلوبة): مندوب مبيعات حلول الدهانات المعمارية والصناعية (SL-204)
(
    'SL-204',
    'مندوب مبيعات حلول الدهانات المعمارية والصناعية',
    'المبيعات',
    'جدة — المنطقة الغربية',
    'دوام كامل',
    'خبرة 2 - 5 سنوات',
    '7,500 - 11,000 ر.س + عمولات ربع سنوية',
    '#E0A21B',
    'قيادة مبيعات قطاع المقاولات والمعارض المعتمدة، وبناء شراكات طويلة الأمد مع المكاتب الهندسية وشركات التطوير العقاري.',
    'تبحث شركة رُواء للدهانات والصناعات الكيميائية عن مندوب/مندوبة مبيعات محترف لتمثيل خطوط الدهانات المعمارية، العوازل المائية، والطلاءات الديكورية لدى كبار العملاء والمشاريع في المنطقة الغربية. يتطلب الدور فهماً عملياً لمعدلات التغطية والمواصفات الفنية وقدرة عالية على التفاوض وإغلاق الصفقات.',
    '[
        "إدارة محفظة عملاء قطاع المشاريع والمعارض وتحقيق المستهدفات البيعية الشهرية والربع سنوية.",
        "تقديم العروض الفنية والمالية للدهانات الديكورية والواقيات الصناعية بالتنسيق مع فريق الدعم الفني.",
        "زيارة مواقع المشاريع قيد الإنشاء والمكاتب الاستشارية لاعتماد منتجات رُواء ضمن قوائم الموردين (Vendor List).",
        "متابعة التحصيل المالي وحدود الائتمان للعملاء وفق سياسة الحوكمة المالية للشركة.",
        "رصد تحركات السوق والمنافسين وتقديم تقارير دورية دقيقة عبر نظام إدارة علاقات العملاء."
    ]'::jsonb,
    '[
        "درجة البكالوريوس أو الدبلوم العالي في التسويق، إدارة الأعمال، أو الهندسة الكيميائية/المدنية.",
        "خبرة عملية لا تقل عن سنتين في مبيعات مواد البناء أو الدهانات أو الحلول الصناعية (B2B).",
        "إجادة حساب المساحات ومعدلات التغطية (م²/لتر) وهوامش الربحية والعروض السعرية.",
        "مهارات تفاوض وعرض استثنائية مع رخصة قيادة سارية والقدرة على التنقل الميداني.",
        "إلمام تام بتطبيقات الأوفيس وأنظمة المبيعات السحابية."
    ]'::jsonb,
    'أنت خبير استقطاب في قطاع الدهانات ومواد البناء في السوق السعودي. قيّم المتقدم لوظيفة (مندوب مبيعات SL-204) مع إخفاء الهوية الشخصية تماماً (Blind Screening). ركّز على: 1) القدرة البيعية في قطاع B2B والمشاريع، 2) الدقة الحسابية في تسعير التوريد ومعدل تغطية الدهانات وهوامش الربح، 3) منهجية التعامل مع اعتراضات العملاء حول السعر مقابل الجودة وطول العمر الافتراضي للطلاء، 4) سلامة مؤشرات النزاهة أثناء الاختبار.',
    60.00,
    20,
    '[
        {
            "index": 1,
            "type": "mcq",
            "points": 10,
            "question": "عند تقديم عرض فني ومالي لمقاول مشروع سكني يشتكي من أن سعر جالون الدهان المقاوم للرطوبة أعلى بنسبة 12% من منافس تجاري، ما هو الأسلوب البيعي الأكثر احترافية؟",
            "options": [
                "تقديم خصم فوري بنسبة 15% دون الرجوع للإدارة لضمان إغلاق الصفقة سريعاً",
                "توضيح التكلفة الكلية للمتر المربع (معدل التغطية الأعلى + تقليل عدد الأوجه + الضمان المعتمد 10 سنوات)",
                "انتقاد جودة منتجات المنافس أمام الاستشاري والمقاول بشكل مباشر",
                "الاعتذار عن المشروع والتركيز فقط على العملاء الذين لا يناقشون الأسعار"
            ],
            "correct_option": 1,
            "explanation": "البيع القيمي (Value-Based Selling) عبر حساب تكلفة المتر المربع الفعلي والعمر الافتراضي هو المعيار الذهبي في مبيعات الدهانات."
        },
        {
            "index": 2,
            "type": "numeric",
            "points": 10,
            "question": "يحتاج مشروع واجهات إلى طلاء مساحة صافية قدرها 2,400 متر مربع بوجهين (2 Coats). إذا كان معدل التغطية الفعلي للتر الواحد للوجه الواحد هو 12 متر مربع/لتر، فكم لتراً من الدهان يجب تسعيره في عرض الكميات؟",
            "correct_number": 400,
            "tolerance": 2,
            "unit": "لتر",
            "explanation": "إجمالي المساحة لوجهين = 2400 × 2 = 4800 م². الكمية المطلوبة = 4800 ÷ 12 = 400 لتر."
        },
        {
            "index": 3,
            "type": "mcq",
            "points": 10,
            "question": "أي وثيقة فنية يطلبها المهندس الاستشاري عادةً لاعتماد مواصفات الطلاء ونسبة المواد الصلبة ومقاومة العوامل الجوية قبل التوريد للموقع؟",
            "options": [
                "سند القبض المالي فقط",
                "النشرة الفنية للمنتج (TDS) ونشرة بيانات السلامة (MSDS)",
                "كشف حضور مندوبي المبيعات",
                "عقد إيجار المستودع الفرعي"
            ],
            "correct_option": 1,
            "explanation": "الاستشاري الهندسي يعتمد المنتج بناءً على النشرة الفنية (Technical Data Sheet - TDS) وشهادات الاختبار والسلامة (MSDS)."
        },
        {
            "index": 4,
            "type": "text",
            "points": 10,
            "question": "اشرح بخطوات عملية كيف ستبني خطة عمل أول 30 يوماً لك لاستقطاب 5 مكاتب هندسية أو شركات مقاولات جديدة في مدينة جدة؟",
            "keywords": ["حصر", "زيارة", "تصنيف", "عينات", "استشاري", "متابعة", "مشاريع", "اعتماد", "عروض"],
            "min_words": 20,
            "explanation": "تقييم التخطيط الميداني، بناء قوائم العملاء المستهدفين، تقديم العينات والكتالوجات اللونية، وجدولة المتابعة."
        },
        {
            "index": 5,
            "type": "numeric",
            "points": 10,
            "question": "إذا كانت تكلفة توريد طلبية دهانات إيبوكسي للأرضيات على الشركة هي 34,000 ريال، وتم بيعها للعميل بمبلغ 40,000 ريال (غير شامل الضريبة)، فكم تبلغ نسبة هامش الربح الإجمالي (Gross Margin %) من سعر البيع؟",
            "correct_number": 15,
            "tolerance": 0.5,
            "unit": "%",
            "explanation": "الربح الإجمالي = 40,000 - 34,000 = 6,000 ريال. نسبة هامش الربح من المبيعات = (6,000 ÷ 40,000) × 100 = 15%."
        },
        {
            "index": 6,
            "type": "mcq",
            "points": 10,
            "question": "طلب عميل آجل توريد دفعة جديدة بقيمة 80,000 ريال بينما تجاوز سقفه الائتماني ولديه فاتورة مستحقة متأخرة منذ 45 يوماً. ما التصرف الصحيح؟",
            "options": [
                "شحن البضاعة فوراً بتعميد شفهي للحفاظ على العلاقة",
                "التنسيق لتحصيل المديونية المستحقة أو تقديم ضمان/دفعة نقدية وموافقة لجنة الائتمان قبل الشحن",
                "إلغاء حساب العميل نهائياً من النظام دون تواصل",
                "تسجيل الطلبية باسم عميل آخر لديه رصيد متاح"
            ],
            "correct_option": 1,
            "explanation": "الانضباط الائتماني وحماية التدفق النقدي جزء أساسي من مسؤولية مندوب المبيعات المحترف."
        },
        {
            "index": 7,
            "type": "text",
            "points": 10,
            "question": "تلقيت اتصالاً من مدير مشروع يفيد بظهور تقشّر في الطلاء بعد أسبوع من التطبيق في الموقع، وهو يلقي اللوم على جودة الدهان. كيف تدير هذا الموقف مهنياً؟",
            "keywords": ["معاينة", "فني", "رطوبة", "تأسيس", "سطح", "تقرير", "حل", "هدوء", "بريمر"],
            "min_words": 20,
            "explanation": "قياس سرعة الاستجابة، اصطحاب مهندس الدعم الفني لمعاينة تجهيز السطح ونسبة الرطوبة والأساس (Primer)، واحتواء العميل بحلول علمية."
        },
        {
            "index": 8,
            "type": "mcq",
            "points": 10,
            "question": "ما الميزة الأهم لأنظمة الخلط اللوني الفوري (Tinting Systems) داخل معارض الدهانات المعتمدة؟",
            "options": [
                "زيادة حجم المخزون الراكد من الألوان الجاهزة",
                "تمكين العميل من الحصول على آلاف الدرجات اللونية بدقة قياسية خلال دقائق مع تقليل المخزون الراكد",
                "إلغاء الحاجة إلى قواعد الدهان الأساسية (Bases)",
                "تقليل عمر صلاحية العبوة إلى يوم واحد"
            ],
            "correct_option": 1,
            "explanation": "أنظمة التلوين الفوري تمنح مرونة لونية هائلة وتخفض تكلفة تكديس الألوان الجاهزة."
        },
        {
            "index": 9,
            "type": "text",
            "points": 10,
            "question": "اذكر أبرز إنجاز بيعي حققته سابقاً (أو موقفاً تفاوضياً نجحت فيه) مع توضيح الأرقام أو النتيجة الملموسة.",
            "keywords": ["مبيعات", "عميل", "نسبة", "تحقيق", "عقد", "صفقة", "هدف", "تفاوض", "مشروع"],
            "min_words": 15,
            "explanation": "رصد التوجه نحو النتائج القابلة للقياس والأثر الفعلي."
        },
        {
            "index": 10,
            "type": "portfolio",
            "points": 10,
            "question": "أرفق نموذج عرض سعر فني/تجاري سابق (مع طمس أي بيانات سرية)، أو شهادة خبرة/دورة مبيعات، أو اكتب ملخصاً لنموذج عرض بيعي مقترح لمشروع دهانات.",
            "keywords": ["عرض", "توريد", "مواصفات", "دفعات", "ضمان", "تغطية"],
            "explanation": "تقييم جودة التوثيق المهني والقدرة على إعداد العروض الفنية والتجارية."
        }
    ]'::jsonb,
    TRUE
),

-- الوظيفة الثانية: مهندس إنتاج وخلط ألوان صناعية (PT-101)
(
    'PT-101',
    'مهندس إنتاج وخلط ألوان صناعية',
    'الإنتاج',
    'جدة — المدينة الصناعية الثانية',
    'دوام كامل',
    'خبرة 3 - 6 سنوات',
    '10,500 - 14,500 ر.س',
    '#C8553D',
    'الإشراف على خطوط إنتاج الدهانات المائية والمذيبات، وضبط عمليات الطحن والتشتيت ومطابقة الألوان القياسية.',
    'قيادة العمليات التشغيلية اليومية في مصنع رُواء للدهانات، وضمان كفاءة خلاطات السرعة العالية (High-Speed Dispersers) ومطاحن الخرز، وتقليل الفاقد التشغيلي مع الالتزام الصارم بمعايير السلامة المهنية والبيئية.',
    '[
        "تخطيط ومتابعة أوامر التشغيل اليومية لخطوط الدهانات المعمارية والصناعية.",
        "ضبط معايير التشتيت ونعومة الحبيبات (Hegman Gauge) واللزوجة قبل ترحيل التشغيلات للتعبئة.",
        "تحسين زمن تبديل التشغيلات اللونية وتقليل الهدر في المذيبات والراتنجات.",
        "تطبيق اشتراطات السلامة الصناعية (OSHA) في التعامل مع المواد الكيميائية القابلة للاشتعال."
    ]'::jsonb,
    '[
        "بكالوريوس في الهندسة الكيميائية أو الهندسة الصناعية أو الكيمياء التطبيقية.",
        "خبرة لا تقل عن 3 سنوات في مصانع الدهانات أو الأحبار أو البوليمرات.",
        "معرفة عملية بأجهزة قياس اللزوجة (KU / Brookfield) ومطياف الألوان (Spectrophotometer)."
    ]'::jsonb,
    'قيّم المتقدم لوظيفة مهندس إنتاج دهانات (PT-101) بالتركيز على: هندسة العمليات الكيميائية، جودة التشتيت والطحن، حسابات الإنتاجية والفاقد، ومعايير السلامة الصناعية.',
    60.00,
    25,
    '[
        {"index":1,"type":"mcq","points":10,"question":"ما الغرض الأساسي من استخدام مقياس هيجمان (Hegman Gauge) أثناء تصنيع الدهان؟","options":["قياس درجة غليان المذيب","قياس درجة نعومة تشتيت الصبغات والحبيبات الصلبة","قياس ضغط الهواء في المستودع","تحديد وزن العبوة الفارغة"],"correct_option":1},
        {"index":2,"type":"numeric","points":10,"question":"إذا كان أمر التشغيل يتطلب إنتاج 5,000 كجم من دهان أساسي بنسبة فاقد تشغيلي مسموح 2%، فكم كيلوجراماً من المواد الخام الإجمالية يلزم تحضيرها لتعويض الفاقد تقريباً (أقرب رقم صحيح لـ 5000 / 0.98 أو 5000 × 1.02)؟","correct_number":5100,"tolerance":5,"unit":"كجم"},
        {"index":3,"type":"mcq","points":10,"question":"في أي مرحلة تضاف المواد المانعة للرغوة (Defoamers) والمواد الرابطة الحساسة للقص العالي عادةً؟","options":["تحت أقصى سرعة طحن حرارية دائماً","خلال مرحلة التهدئة والتخفيف (Let-down stage) وفق التركيبة المعتمدة","بعد إغلاق العبوات النهائية","لا تستخدم في الدهانات المائية إطلاقاً"],"correct_option":1},
        {"index":4,"type":"text","points":10,"question":"اشرح كيف تتعامل مع انحراف قيمة فرق اللون (Delta E > 1.5) في تشغيلة حجمها 3 أطنان قبل التعبئة؟","keywords":["مطياف","تعديل","صبغة","عينة","مختبر","تدريجي","خلط"],"min_words":18},
        {"index":5,"type":"numeric","points":10,"question":"خط تعبئة ينتج 40 جالوناً في الدقيقة ويعمل بفعالية تشغيلية (OEE) قدرها 75%. كم جالوناً ينتج فعلياً خلال ساعة واحدة؟","correct_number":1800,"tolerance":5,"unit":"جالون"},
        {"index":6,"type":"mcq","points":10,"question":"ما الإجراء الهندسي الأهم لمنع تراكم الشحنات الكهروستاتيكية أثناء نقل المذيبات العضوية؟","options":["زيادة سرعة الضخ للحد الأقصى","التأريض والربط الكهربائي المحكم (Grounding & Bonding) لجميع الخزانات والأنابيب","إيقاف التهوية الميكانيكية","استخدام أنابيب بلاستيكية غير موصلة دون تأريض"],"correct_option":1},
        {"index":7,"type":"text","points":10,"question":"صف منهجيتك لتقليل وقت التنظيف عند الانتقال من تصنيع لون داكن إلى لون فاتح على نفس الخط.","keywords":["جدولة","تدرج","فاتح","داكن","غسيل","مذيب","تخطيط"],"min_words":15},
        {"index":8,"type":"mcq","points":10,"question":"أي وحدة تُشاع في قياس لزوجة الدهانات المعمارية متوسطة القوام باستخدام جهاز Stormer؟","options":["وحدة كريبس (KU - Krebs Units)","الأمبير الحراري","الديسيبل الصوتي","اللومن الضوئي"],"correct_option":0},
        {"index":9,"type":"text","points":10,"question":"اذكر أهم مؤشرات الأداء (KPIs) التي تراقبها يومياً كمهندس إنتاج في مصنع دهانات.","keywords":["جودة","هدر","سلامة","التزام","إنتاجية","توقف","طاقة"],"min_words":15},
        {"index":10,"type":"portfolio","points":10,"question":"أرفق شهادة مهنية (مثل Lean / Six Sigma / OSHA) أو مخطط تحسين عملية إنتاجية شاركت فيه، أو لخّص مشروع تحسين صناعي نفذته.","keywords":["تحسين","إنتاج","جودة","فاقد","سلامة"]}
    ]'::jsonb,
    TRUE
),

-- الوظيفة الثالثة: مهندس مشاريع وعقود دهانات ديكورية وواقيات (PR-302)
(
    'PR-302',
    'مهندس مشاريع وعقود دهانات ديكورية وواقيات',
    'المشاريع',
    'الرياض / جدة',
    'دوام كامل',
    'خبرة 3 - 7 سنوات',
    '11,000 - 15,000 ر.س + بدل مشاريع',
    '#3B5B78',
    'إدارة عقود التوريد والتنفيذ للمشاريع الكبرى، واعتماد الأنظمة الطلائية المقاومة للحريق والعوازل لدى الاستشاريين.',
    'تولي إدارة دورة حياة مشاريع الطلاء الكبرى بدءاً من دراسة جداول الكميات (BOQ) وتقديم العينات الميدانية (Mock-ups) وحتى التسليم الابتدائي والنهائي وضبط المستخلصات الهندسية.',
    '[
        "دراسة كراسات الشروط والمواصفات وجداول الكميات (BOQ) للمشاريع الحكومية والتجارية.",
        "الإشراف على تنفيذ عينات الاعتماد الميدانية (Site Mock-ups) بحضور الاستشاري.",
        "متابعة قياسات سماكة الفيلم الجاف (DFT) واختبارات الالتصاق في المواقع.",
        "إعداد المستخلصات الشهرية ومحاضر الاستلام المرحلية."
    ]'::jsonb,
    '[
        "بكالوريوس هندسة مدنية أو معمارية أو كيميائية مع عضوية الهيئة السعودية للمهندسين.",
        "خبرة عملية في مشاريع التشطيبات أو الطلاءات الواقية (Protective Coatings) والعوازل.",
        "شهادة NACE / AMPP أو PMP تعد ميزة تفضيلية عالية."
    ]'::jsonb,
    'قيّم المتقدم لوظيفة مهندس مشاريع (PR-302) بالتركيز على: قراءة جداول الكميات BOQ، اختبارات سماكة الطلاء DFT والالتصاق، إدارة المستخلصات والجدول الزمني، والتعامل مع الاستشاريين.',
    60.00,
    20,
    '[
        {"index":1,"type":"mcq","points":10,"question":"ما الاختصار الهندسي المتعارف عليه لقياس سماكة طبقة الطلاء بعد جفافها الكامل على الهياكل المعدنية أو الخرسانية؟","options":["DFT (Dry Film Thickness)","WFT فقط قبل الخلط","RPM","PVC"],"correct_option":0},
        {"index":2,"type":"numeric","points":10,"question":"بند في جدول الكميات مساحته 3,500 م² بسعر عقد 42 ريال/م² (توريد وتنفيذ). إذا بلغت نسبة الإنجاز المعتمدة في المستخلص الأول 30%، فما قيمة المستخلص قبل الحسميات والضريبة؟","correct_number":44100,"tolerance":10,"unit":"ريال"},
        {"index":3,"type":"mcq","points":10,"question":"قبل تطبيق دهان الإيبوكسي على أرضية خرسانية جديدة، ما الشرط الفني الحاسم لتجنب الانفصال والتقشر؟","options":["رش الأرضية بالماء قبل الطلاء بنصف ساعة","التأكد من جفاف الخرسانة (نسبة الرطوبة ضمن الحد المسموح < 4%) وتخشين السطح ميكانيكياً","إلغاء طبقة البرايمر تماماً","التطبيق تحت أشعة الشمس المباشرة وقت الظهيرة"],"correct_option":1},
        {"index":4,"type":"text","points":10,"question":"كيف تدير طلب تغيير (Variation Order) طلبه ممثل المالك شفوياً لتغيير نظام الدهان من عادي إلى مقاوم للبكتيريا في مبنى صحي؟","keywords":["توثيق","تعميد","خطي","تكلفة","جدول","استشاري","اعتماد"],"min_words":18},
        {"index":5,"type":"numeric","points":10,"question":"إذا كانت سماكة الطلاء الرطب (WFT) تساوي 200 ميكرون ونسبة المواد الصلبة بالحجم (Volume Solids) هي 60%، فكم تبلغ سماكة الطلاء الجاف النظرية (DFT) بالميكرون؟","correct_number":120,"tolerance":2,"unit":"ميكرون"},
        {"index":6,"type":"mcq","points":10,"question":"أي اختبار ميداني يُستخدم للتحقق من قوة التصاق الطلاء بالسطح وفق معيار ASTM D4541؟","options":["اختبار السحب (Pull-Off Adhesion Test)","اختبار التوصيل الصوتي","اختبار الحموضة الورقي","اختبار الكثافة النوعية للماء"],"correct_option":0},
        {"index":7,"type":"text","points":10,"question":"اشرح خطوات تجهيز واعتماد عينة موقعية (Mock-up) لواجهة مشروع فندقي لضمان عدم حدوث خلاف عند الاستلام النهائي.","keywords":["سطح","طبقات","عينة","توقيع","استشاري","مرجع","إضاءة"],"min_words":15},
        {"index":8,"type":"mcq","points":10,"question":"عند تأخر المقاول الرئيسي في تسليم الحوائط اللياسة جاهزة للدهان، ما الإجراء التعاقدي لحماية برنامجك الزمني؟","options":["الانتظار بصمت دون مراسلات","إرسال إشعار رسمي بعدم جاهزية الموقع وتثبيت الأثر على الجدول الزمني","بدء الدهان فوق اللياسة الرطبة غير المكتملة","سحب جميع العمالة نهائياً دون إخطار"],"correct_option":1},
        {"index":9,"type":"text","points":10,"question":"تحدث عن أكبر مشروع تشطيبات أو طلاءات أشرفت عليه وكيف ضبطت الجودة والهدر في المواد.","keywords":["مشروع","مساحة","جودة","تسليم","فريق","مواد"],"min_words":15},
        {"index":10,"type":"portfolio","points":10,"question":"أرفق سابقة أعمال مشاريع (Project Portfolio) أو نموذج تقرير فحص موقعي أعددته سابقاً.","keywords":["مشروع","فحص","تقرير","اعتماد"]}
    ]'::jsonb,
    TRUE
),

-- الوظيفة الرابعة: أخصائي مختبر وضبط جودة الطلاءات (QC-105)
(
    'QC-105',
    'أخصائي مختبر وضبط جودة الطلاءات',
    'الجودة',
    'جدة — المختبر المركزي',
    'دوام كامل',
    'خبرة 2 - 4 سنوات',
    '8,500 - 11,500 ر.س',
    '#2F5D50',
    'فحص المواد الخام والتشغيلات النهائية وفق مواصفات SASO وASTM وإصدار شهادات المطابقة الفنية.',
    'إجراء الاختبارات الفيزيائية والكيميائية على الراتنجات والصبغات والمنتج التام، وإدارة عينات الاحتفاظ المرجعية، وضمان مطابقة كافة المنتجات للوائح الهيئة السعودية للمواصفات والمقاييس والجودة (SASO).',
    '[
        "فحص اللزوجة، الكثافة، الأس الهيدروجيني (pH)، نسبة المواد الصلبة، وقوة التغطية (Contrast Ratio).",
        "مطابقة الألوان باستخدام Spectrophotometer وحفظ العينات المرجعية لكل تشغيلة.",
        "مراقبة اختبارات التقادم المتسارع ومقاومة الغسيل والاحتكاك (Scrub Resistance).",
        "التحقيق في شكاوى الجودة وإصدار تقارير الإجراءات التصحيحية والوقائية (CAPA)."
    ]'::jsonb,
    '[
        "بكالوريوس في الكيمياء الصناعية أو الكيمياء العامة.",
        "إلمام عملي بمواصفات SASO / ISO 9001 واختبارات ASTM الخاصة بالدهانات.",
        "دقة عالية في التوثيق المخبري ومعايرة الأجهزة."
    ]'::jsonb,
    'قيّم المتقدم لوظيفة أخصائي ضبط جودة الطلاءات (QC-105) بالتركيز على: دقة الفحوصات المخبرية، مواصفات SASO وASTM، حساب نسبة المواد الصلبة وقوة التغطية، ومنهجية التحقيق الجذري CAPA.',
    60.00,
    20,
    '[
        {"index":1,"type":"mcq","points":10,"question":"ماذا تقيس نسبة التباين (Contrast Ratio) عند تطبيق فيلم دهان على بطاقة Leneta البيضاء والسوداء؟","options":["سرعة تبخر المذيب","قوة التغطية والإخفاء البصري للدهان (Hiding Power)","نسبة الرصاص في العبوة","مقاومة الحريق لمدة ساعتين"],"correct_option":1},
        {"index":2,"type":"numeric","points":10,"question":"وُزنت عينة دهان رطبة فكانت 2.50 جرام، وبعد تجفيفها في الفرن القياسي أصبح وزن المتبقي الصلب 1.35 جرام. كم تبلغ نسبة المواد الصلبة بالوزن (Weight Solids %)؟","correct_number":54,"tolerance":0.5,"unit":"%"},
        {"index":3,"type":"mcq","points":10,"question":"ما النطاق النموذجي للأس الهيدروجيني (pH) لضمان استقرار معظم الدهانات المائية الأكريليكية أثناء التخزين؟","options":["1.5 إلى 2.5 (شديد الحموضة)","8.0 إلى 9.5 (قلوي خفيف مستقر)","13.5 إلى 14.0","4.0 تماماً"],"correct_option":1},
        {"index":4,"type":"text","points":10,"question":"اشرح خطوات إعداد تقرير إجراء تصحيحي ووقائي (CAPA) عند رصد ترسب صبغات في تشغيلة مخزنة منذ شهرين.","keywords":["سبب","جذري","عينة","لزوجة","مشتت","إجراء","منع","تحليل"],"min_words":18},
        {"index":5,"type":"numeric","points":10,"question":"إذا كان حجم بكنوميتر القياس (Pycnometer) هو 100 مل، ووزن الدهان داخله 132 جراماً، فكم تبلغ كثافة الدهان (جم/مل)؟","correct_number":1.32,"tolerance":0.02,"unit":"جم/مل"},
        {"index":6,"type":"mcq","points":10,"question":"ما الغرض من وضع حد أقصى للمركبات العضوية المتطايرة (VOC) في لوائح SASO للدهانات الداخلية؟","options":["زيادة رائحة المذيبات","حماية صحة المستخدمين وجودة الهواء الداخلي والبيئة","تقليل قوة التصاق الدهان","تغيير لون العبوة الخارجية"],"correct_option":1},
        {"index":7,"type":"text","points":10,"question":"كيف تتحقق من دقة معايرة أجهزة المختبر (الميزان الحساس، جهاز اللزوجة، جهاز الألوان) قبل اعتماد نتائج الوردية؟","keywords":["معايرة","قياسي","سجل","يومي","بلاطة","انحراف","صلاحية"],"min_words":15},
        {"index":8,"type":"mcq","points":10,"question":"متى يحق لأخصائي ضبط الجودة تعليق الإفراج عن تشغيلة إنتاجية (Quality Hold)؟","options":["فقط بعد بيع التشغيلة للعملاء","فوراً عند خروج أي معيار حرج عن الحدود المعتمدة في المواصفة الفنية","لا يحق له ذلك مطلقاً مهما كانت النتيجة","في نهاية السنة المالية فقط"],"correct_option":1},
        {"index":9,"type":"text","points":10,"question":"لخّص خبرتك في تطبيق نظام ISO 9001 أو التعامل مع التدقيق الخارجي للمختبرات.","keywords":["تدقيق","توثيق","مواصفة","جودة","إجراءات","سجلات"],"min_words":15},
        {"index":10,"type":"portfolio","points":10,"question":"أرفق نموذج شهادة تحليل (COA) غير سرية أو شهادة دورة ISO/جودة، أو اكتب العناصر الأساسية لشهادة مطابقة تشغيلة دهان.","keywords":["تشغيلة","مطابقة","لزوجة","كثافة","لون"]}
    ]'::jsonb,
    TRUE
),

-- الوظيفة الخامسة: مشرف مستودعات وسلاسل إمداد المواد الكيميائية (WH-401)
(
    'WH-401',
    'مشرف مستودعات وسلاسل إمداد المواد الكيميائية',
    'المستودعات',
    'الدمام / جدة',
    'دوام كامل',
    'خبرة 3 - 5 سنوات',
    '8,000 - 10,500 ر.س',
    '#7A5C43',
    'إدارة مخزون المواد الخام والمنتجات التامة وفق نظام FEFO واشتراطات السلامة لتخزين المواد الكيميائية.',
    'ضبط حركة الاستلام والتخزين والتوزيع لمنتجات رُواء للدهانات، وضمان دقة الجرد المستمر وتطبيق معايير الدفاع المدني وفصل المواد الخطرة وتوجيه أسطول التوصيل.',
    '[
        "تطبيق مبدأ ما تنتهي صلاحيته أولاً يُصرف أولاً (FEFO) لجميع قواعد الدهانات والمصلبات.",
        "ضمان فصل مناطق تخزين المذيبات القابلة للاشتعال ومراقبة درجات الحرارة والتهوية.",
        "مطابقة أرصدة نظام ERP مع الجرد الفعلي الدوري والسنوي بدقة تتجاوز 99.5%.",
        "جدولة التحميل اليومي لطلبيات الفروع والمشاريع دون تأخير."
    ]'::jsonb,
    '[
        "دبلوم عالٍ أو بكالوريوس في سلاسل الإمداد، اللوجستيات، أو إدارة الأعمال.",
        "خبرة لا تقل عن 3 سنوات في مستودعات المواد الكيميائية أو الدهانات أو السلع الصناعية.",
        "إجادة العمل على أنظمة WMS / ERP."
    ]'::jsonb,
    'قيّم المتقدم لوظيفة مشرف مستودعات (WH-401) بالتركيز على: تطبيق منهجية FEFO، سلامة تخزين المواد الكيميائية وبطاقات MSDS، دقة الجرد في أنظمة WMS، وكفاءة التوزيع.',
    60.00,
    20,
    '[
        {"index":1,"type":"mcq","points":10,"question":"لماذا يُفضّل تطبيق نظام FEFO بدلاً من LIFO في مستودعات الدهانات والمصلبات الإيبوكسية؟","options":["لأن المصلبات والدهانات لها تاريخ انتهاء صلاحية يتأثر بالتخزين الطويل","لزيادة تكدس البضاعة القديمة في آخر المستودع","لإلغاء الحاجة إلى كتابة رقم التشغيلة","لتقليل عدد الرفوف المستخدمة"],"correct_option":0},
        {"index":2,"type":"numeric","points":10,"question":"إذا كان الرصيد الدفتري على النظام لصنف برايمر أكريليك هو 1,200 جالون، وأظهر الجرد الفعلي وجود 1,188 جالوناً، فكم تبلغ نسبة دقة المخزون المئوية؟","correct_number":99,"tolerance":0.2,"unit":"%"},
        {"index":3,"type":"mcq","points":10,"question":"ما الوثيقة الإلزامية التي يجب توفرها في منطقة تخزين كل مادة كيميائية لتوضيح مخاطر الاشتعال وطرق الإطفاء والإسعافات؟","options":["نشرة بيانات سلامة المواد (SDS / MSDS)","قائمة أسعار التجزئة","جدول الإجازات السنوية","كتالوج الديكور الداخلي"],"correct_option":0},
        {"index":4,"type":"text","points":10,"question":"كيف تتصرف فور حدوث انسكاب محدود لبرميل مذيب عضوي في منطقة الاستلام بالمستودع؟","keywords":["عزل","تهوية","اشتعال","معدات","امتصاص","سلامة","تقرير"],"min_words":18},
        {"index":5,"type":"numeric","points":10,"question":"تتسع الطبلية القياسية (Pallet) لـ 36 جالون دهان. كم طبلية كاملة تلزم لشحن طلبية مكونة من 540 جالوناً؟","correct_number":15,"tolerance":0,"unit":"طبلية"},
        {"index":6,"type":"mcq","points":10,"question":"عند استلام شحنة مواد خام بها عبوات منتفخة أو متضررة، ما الإجراء المستودعي السليم؟","options":["إدخالها مباشرة مع المخزون السليم","عزلها في منطقة الحجر/المرفوضات وتوثيق محضر استلام بالملاحظات وإبلاغ الجودة والمشتريات","إتلافها دون توثيق أو رجوع للمورد","توزيعها على الفروع البعيدة"],"correct_option":1},
        {"index":7,"type":"text","points":10,"question":"اشرح آلية الجرد الدوري (Cycle Counting) وكيف تساهم في رفع دقة المخزون دون إيقاف عمل المستودع.","keywords":["تصنيف","ABC","يومي","مطابقة","فروقات","دوران","توقف"],"min_words":15},
        {"index":8,"type":"mcq","points":10,"question":"في تصنيف المخزون ABC، ماذا تمثل الأصناف من الفئة (A)؟","options":["الأصناف الأعلى قيمة وتأثيراً في المبيعات والتي تتطلب رقابة صارمة","الأصناف التالفة فقط","القرطاسية المكتبية منخفضة القيمة","المعدات خارج الخدمة"],"correct_option":0},
        {"index":9,"type":"text","points":10,"question":"اذكر أبرز نظام ERP أو WMS عملت عليه وكيف حسّنت سرعة تجهيز الطلبيات في عملك السابق.","keywords":["نظام","تحضير","توجيه","رفوف","دقة","وقت"],"min_words":15},
        {"index":10,"type":"portfolio","points":10,"question":"أرفق شهادة سلامة مستودعات أو سلاسل إمداد، أو لخّص قائمة فحص يومية (Checklist) تقترحها لمستودع دهانات.","keywords":["فحص","حرارة","طفايات","ممرات","رصيد"]}
    ]'::jsonb,
    TRUE
)
ON CONFLICT (code) DO NOTHING;

-- 3. سجل المتقدمين الافتراضيين (بما فيهم المرشحة الافتراضية لوظيفة مندوب مبيعات SL-204)
INSERT INTO candidates (
    full_name, email, phone, city, years_experience, qualification,
    portfolio_url, cv_filename, cv_stored_path, cv_extracted_text
)
VALUES
(
    'سارة بنت عبدالله الغامدي',
    'sara.alghamdi@example-hr.sa',
    '966551234567',
    'جدة',
    4.5,
    'بكالوريوس تسويق وإدارة أعمال — جامعة الملك عبدالعزيز',
    'https://portfolio.example-hr.sa/sara-b2b-sales',
    'Sara_AlGhamdi_Sales_CV.pdf',
    '/uploads/samples/Sara_AlGhamdi_Sales_CV.pdf',
    'خبرة 4.5 سنوات في مبيعات مشاريع مواد البناء والدهانات المعمارية في جدة، إدارة محفظة 35 مكتب استشاري وشركة مقاولات، تحقيق 118% من المستهدف السنوي، إتقان إعداد العروض الفنية والمالية وحساب معدلات التغطية (TDS) ومتابعة التحصيل الائتماني.'
),
(
    'نورة بنت محمد الحربي',
    'noura.alharbi@example-hr.sa',
    '966509876543',
    'جدة',
    3.0,
    'بكالوريوس إدارة سلاسل الإمداد والتسويق',
    'https://portfolio.example-hr.sa/noura-coatings',
    'Noura_AlHarbi_CV.pdf',
    '/uploads/samples/Noura_AlHarbi_CV.pdf',
    'خبرة 3 سنوات في مبيعات المعارض وحلول الديكور الداخلي وأنظمة الخلط اللوني الفوري، بناء شراكات مع مصممي الديكور والمقاولين الفرعيين في جدة ومكة المكرمة.'
),
(
    'م. فهد بن سالم القحطاني',
    'fahad.alqahtani@example-hr.sa',
    '966543218765',
    'جدة',
    5.0,
    'بكالوريوس هندسة كيميائية — جامعة الملك فهد للبترول والمعادن',
    NULL,
    'Eng_Fahad_Production_CV.pdf',
    '/uploads/samples/Eng_Fahad_Production_CV.pdf',
    'مهندس إنتاج كيميائي بخبرة 5 سنوات في تصنيع الدهانات المائية والإيبوكسية، ضبط التشتيت واللزوجة KU ومطياف الألوان Delta E، خفض الهدر التشغيلي بنسبة 19% وتطبيق منهجية Lean.'
),
(
    'خالد بن عبدالرحمن الزهراني',
    'khalid.alzahrani@example-hr.sa',
    '966567891234',
    'جدة',
    2.5,
    'دبلوم عالٍ مبيعات صناعية وتسويق',
    NULL,
    'Khalid_AlZahrani_CV.pdf',
    '/uploads/samples/Khalid_AlZahrani_CV.pdf',
    'خبرة سنتين ونصف في المبيعات الميدانية لمواد العزل والدهانات الخارجية، متابعة طلبيات المعارض وتحصيل الذمم المالية.'
),
(
    'ريم بنت طلال العتيبي',
    'reem.alotaibi@example-hr.sa',
    '966534567890',
    'جدة',
    3.5,
    'بكالوريوس كيمياء صناعية',
    NULL,
    'Reem_AlOtaibi_QC_CV.pdf',
    '/uploads/samples/Reem_AlOtaibi_QC_CV.pdf',
    'أخصائية مختبر وضبط جودة بخبرة 3.5 سنوات في اختبارات الطلاءات وفق ASTM ولوائح SASO، فحص نسبة المواد الصلبة وقوة التغطية وإعداد تقارير CAPA.'
),
(
    'ماجد بن حسن الشهري',
    'majed.alshehri@example-hr.sa',
    '966591122334',
    'الدمام',
    1.0,
    'دبلوم إدارة مستودعات',
    NULL,
    'Majed_AlShehri_CV.pdf',
    '/uploads/samples/Majed_AlShehri_CV.pdf',
    'خبرة سنة واحدة في استلام البضائع العامة ومناولة المخزون.'
)
ON CONFLICT (email) DO NOTHING;

-- 4. طلبات التوظيف ونتائج الذكاء الاصطناعي (Applications)
INSERT INTO applications (
    reference_no, job_id, candidate_id, status,
    cv_match_score, assessment_score, ai_overall_score,
    committee_avg_score, final_weighted_score,
    integrity_score, tab_switches, paste_attempts, time_spent_seconds,
    ai_report, privacy_consent, submitted_at, assessed_at
)
SELECT
    'APP-2026-1001',
    j.id,
    c.id,
    'interview_scheduled',
    91.00,
    87.00,
    88.20,
    0.00,
    0.00,
    96.00,
    1,
    0,
    890,
    '{
        "provider_used": "smart-rubric",
        "blind_code": "CAND-BLIND-882A",
        "blind_summary": "مرشح/ـة يتمتع بخبرة ميدانية قوية (4.5 سنوات) في مبيعات مشاريع الدهانات B2B، أظهر دقة كاملة (100%) في الحسابات الهندسية لمعدلات التغطية وهوامش الربح الإجمالي، ومنهجية ناضجة في البيع القيمي ومعالجة شكاوى المواقع.",
        "strengths": [
            "إتقان حسابات الكميات ومعدلات التغطية (م²/لتر) وهوامش الربح دون أخطاء",
            "فهم عميق لدور النشرات الفنية TDS/MSDS في اعتماد المشاريع لدى الاستشاريين",
            "خطة تطوير أعمال ميدانية واضحة لأول 30 يوماً مع انضباط ائتماني عالٍ"
        ],
        "gaps": [
            "يُوصى بالتحقق خلال المقابلة من خبرة التعامل مع عقود الطلاءات الصناعية الثقيلة (Protective Coatings)"
        ],
        "recommendation": "توصية قوية بالمقابلة (Strong Shortlist)"
    }'::jsonb,
    TRUE,
    NOW() - INTERVAL '4 days',
    NOW() - INTERVAL '4 days' + INTERVAL '18 minutes'
FROM jobs j, candidates c
WHERE j.code = 'SL-204' AND c.email = 'sara.alghamdi@example-hr.sa'
ON CONFLICT (reference_no) DO NOTHING;

INSERT INTO applications (
    reference_no, job_id, candidate_id, status,
    cv_match_score, assessment_score, ai_overall_score,
    integrity_score, tab_switches, paste_attempts, time_spent_seconds,
    ai_report, privacy_consent, submitted_at, assessed_at
)
SELECT
    'APP-2026-1002',
    j.id,
    c.id,
    'passed_assessment',
    84.00,
    81.00,
    81.90,
    100.00,
    0,
    0,
    940,
    '{
        "provider_used": "smart-rubric",
        "blind_code": "CAND-BLIND-819B",
        "blind_summary": "خلفية متميزة في مبيعات المعارض وأنظمة التلوين الفوري، مع إجابات رقمية دقيقة وأداء نزاهة كامل 100%.",
        "strengths": [
            "خبرة مباشرة في أنظمة الخلط اللوني وخدمة المعارض ومصممي الديكور",
            "التزام كامل بنزاهة الاختبار دون أي تبديل تبويبات"
        ],
        "gaps": [
            "تحتاج لتعزيز الخبرة في مناقصات المشاريع الحكومية الكبرى"
        ],
        "recommendation": "مؤهلة للمقابلة الشخصية"
    }'::jsonb,
    TRUE,
    NOW() - INTERVAL '3 days',
    NOW() - INTERVAL '3 days' + INTERVAL '16 minutes'
FROM jobs j, candidates c
WHERE j.code = 'SL-204' AND c.email = 'noura.alharbi@example-hr.sa'
ON CONFLICT (reference_no) DO NOTHING;

INSERT INTO applications (
    reference_no, job_id, candidate_id, status,
    cv_match_score, assessment_score, ai_overall_score,
    integrity_score, tab_switches, paste_attempts, time_spent_seconds,
    ai_report, privacy_consent, submitted_at, assessed_at
)
SELECT
    'APP-2026-1003',
    j.id,
    c.id,
    'interview_scheduled',
    90.00,
    84.00,
    85.80,
    95.00,
    1,
    0,
    1050,
    '{
        "provider_used": "smart-rubric",
        "blind_code": "CAND-BLIND-858C",
        "blind_summary": "مهندس كيميائي متمكن في ضبط عمليات الطحن والتشتيت وتقليل الهدر اللوني ومعايير التأريض الكهروستاتيكي.",
        "strengths": [
            "إلمام تام بمقاييس Hegman وKU ومطياف الألوان Delta E",
            "خبرة موثقة في خفض الفاقد التشغيلي وتطبيق السلامة الصناعية"
        ],
        "gaps": [
            "مناقشة جدول العمل بنظام الورديات في ذروة المواسم"
        ],
        "recommendation": "توصية قوية بالمقابلة الفنية"
    }'::jsonb,
    TRUE,
    NOW() - INTERVAL '2 days',
    NOW() - INTERVAL '2 days' + INTERVAL '21 minutes'
FROM jobs j, candidates c
WHERE j.code = 'PT-101' AND c.email = 'fahad.alqahtani@example-hr.sa'
ON CONFLICT (reference_no) DO NOTHING;

INSERT INTO applications (
    reference_no, job_id, candidate_id, status,
    cv_match_score, assessment_score, ai_overall_score,
    integrity_score, tab_switches, paste_attempts, time_spent_seconds,
    ai_report, privacy_consent, submitted_at, assessed_at
)
SELECT
    'APP-2026-1004',
    j.id,
    c.id,
    'under_review',
    76.00,
    73.00,
    73.90,
    92.00,
    2,
    0,
    820,
    '{
        "provider_used": "smart-rubric",
        "blind_code": "CAND-BLIND-739D",
        "blind_summary": "أداء جيد في أساسيات المبيعات الميدانية والتحصيل، مع حاجة لتعميق المهارات الحسابية لهوامش الربح المركبة.",
        "strengths": [
            "حماس ميداني وخبرة جيدة في متابعة عملاء التجزئة والعوازل",
            "وعي سليم بسياسة السقف الائتماني"
        ],
        "gaps": [
            "تفصيل خطة استقطاب المكاتب الهندسية يحتاج لمؤشرات رقمية أدق"
        ],
        "recommendation": "مؤهل لمراجعة لجنة التوظيف"
    }'::jsonb,
    TRUE,
    NOW() - INTERVAL '1 day',
    NOW() - INTERVAL '1 day' + INTERVAL '15 minutes'
FROM jobs j, candidates c
WHERE j.code = 'SL-204' AND c.email = 'khalid.alzahrani@example-hr.sa'
ON CONFLICT (reference_no) DO NOTHING;

INSERT INTO applications (
    reference_no, job_id, candidate_id, status,
    cv_match_score, assessment_score, ai_overall_score,
    integrity_score, tab_switches, paste_attempts, time_spent_seconds,
    ai_report, privacy_consent, submitted_at, assessed_at
)
SELECT
    'APP-2026-1005',
    j.id,
    c.id,
    'interview_scheduled',
    82.00,
    78.00,
    79.20,
    100.00,
    0,
    0,
    870,
    '{
        "provider_used": "smart-rubric",
        "blind_code": "CAND-BLIND-792E",
        "blind_summary": "كفاءة مخبرية متميزة في اختبارات SASO/ASTM وحسابات المواد الصلبة والكثافة وتقارير CAPA.",
        "strengths": [
            "دقة كاملة في الحسابات المخبرية للمواد الصلبة والكثافة",
            "التزام صارم بصلاحية تعليق الإفراج Quality Hold عند الانحراف"
        ],
        "gaps": [
            "التوسع في اختبارات الطلاءات البحرية والصناعية الثقيلة"
        ],
        "recommendation": "مؤهلة للمقابلة الفنية"
    }'::jsonb,
    TRUE,
    NOW() - INTERVAL '18 hours',
    NOW() - INTERVAL '17 hours'
FROM jobs j, candidates c
WHERE j.code = 'QC-105' AND c.email = 'reem.alotaibi@example-hr.sa'
ON CONFLICT (reference_no) DO NOTHING;

INSERT INTO applications (
    reference_no, job_id, candidate_id, status,
    cv_match_score, assessment_score, ai_overall_score,
    integrity_score, tab_switches, paste_attempts, time_spent_seconds,
    ai_report, privacy_consent, submitted_at, assessed_at
)
SELECT
    'APP-2026-1006',
    j.id,
    c.id,
    'failed_assessment',
    52.00,
    46.00,
    47.80,
    78.00,
    3,
    2,
    510,
    '{
        "provider_used": "smart-rubric",
        "blind_code": "CAND-BLIND-478F",
        "blind_summary": "لم يحقق الحد الأدنى للاجتياز (60%) نتيجة نقص الخبرة في اشتراطات سلامة المواد الكيميائية MSDS وحسابات دقة الجرد.",
        "strengths": [
            "معرفة أولية بعمليات الاستلام العام"
        ],
        "gaps": [
            "ضعف في إجراءات التعامل مع الانسكابات الكيميائية وتطبيق FEFO",
            "انخفاض مؤشر النزاهة بسبب تكرار مغادرة شاشة الاختبار"
        ],
        "recommendation": "عدم ترشيح للدور الإشرافي الحالي"
    }'::jsonb,
    TRUE,
    NOW() - INTERVAL '6 hours',
    NOW() - INTERVAL '5 hours'
FROM jobs j, candidates c
WHERE j.code = 'WH-401' AND c.email = 'majed.alshehri@example-hr.sa'
ON CONFLICT (reference_no) DO NOTHING;

-- 5. تفاصيل الإجابات الـ 10 الكاملة للمرشحة الافتراضية (سارة الغامدي — APP-2026-1001)
INSERT INTO assessment_answers (
    application_id, question_index, question_type, question_text,
    answer_value, attachment_path, max_points, awarded_points, ai_feedback, time_taken_seconds
)
SELECT
    a.id,
    q.idx,
    q.qtype,
    q.qtext,
    q.ans,
    q.att,
    10.00,
    q.pts,
    q.fb,
    q.sec
FROM applications a
CROSS JOIN (
    VALUES
    (1, 'mcq', 'عند تقديم عرض فني ومالي لمقاول مشروع سكني يشتكي من أن سعر جالون الدهان المقاوم للرطوبة أعلى بنسبة 12%...', '1', NULL, 10.00, 'إجابة صحيحة: التركيز على التكلفة الكلية للمتر المربع ومعدل التغطية والضمان.', 65),
    (2, 'numeric', 'يحتاج مشروع واجهات إلى طلاء مساحة صافية قدرها 2,400 متر مربع بوجهين (2 Coats)...', '400', NULL, 10.00, 'إجابة رقمية دقيقة (400 لتر) تطابق المعادلة الهندسية تماماً.', 80),
    (3, 'mcq', 'أي وثيقة فنية يطلبها المهندس الاستشاري عادةً لاعتماد مواصفات الطلاء...', '1', NULL, 10.00, 'إجابة صحيحة: النشرة الفنية TDS ونشرة بيانات السلامة MSDS.', 45),
    (4, 'text', 'اشرح بخطوات عملية كيف ستبني خطة عمل أول 30 يوماً لك لاستقطاب 5 مكاتب هندسية...', 'الأسبوع الأول: حصر وتصنيف المكاتب الاستشارية وشركات المقاولات النشطة في جدة حسب حجم المشاريع. الأسبوع الثاني: زيارات ميدانية لتقديم ملف الاعتماد الفني (Vendor Submittal) والنشرات الفنية وعينات الألوان. الأسبوع الثالث: تنفيذ عينات موقعية Mock-ups للمشاريع الجاهزة وتسعير جداول الكميات. الأسبوع الرابع: متابعة قرارات الاعتماد وإغلاق أول عقود التوريد.', NULL, 9.00, 'خطة منهجية مقسمة زمنياً تغطي الحصر، الزيارات، عينات الاعتماد، والإغلاق.', 155),
    (5, 'numeric', 'إذا كانت تكلفة توريد طلبية دهانات إيبوكسي للأرضيات على الشركة هي 34,000 ريال، وتم بيعها بمبلغ 40,000 ريال...', '15', NULL, 10.00, 'حساب مالي دقيق لهامش الربح الإجمالي (15%).', 70),
    (6, 'mcq', 'طلب عميل آجل توريد دفعة جديدة بقيمة 80,000 ريال بينما تجاوز سقفه الائتماني...', '1', NULL, 10.00, 'إجابة صحيحة تعكس التزاماً بحوكمة الائتمان والتحصيل.', 50),
    (7, 'text', 'تلقيت اتصالاً من مدير مشروع يفيد بظهور تقشّر في الطلاء بعد أسبوع من التطبيق...', 'أستمع للعميل بهدوء وأحدد موعد معاينة ميدانية خلال 24 ساعة برفقة مهندس الدعم الفني لفحص نسبة رطوبة الحائط، جودة تجهيز السطح، واستخدام البرايمر المناسب، ثم نرفع تقريراً فنياً مشتركاً مع معالجة الجزء المتضرر لضمان رضا العميل واستمرار العلاقة.', NULL, 9.00, 'استجابة احترافية تجمع بين احتواء العميل والتشخيص الفني الدقيق للسطح والرطوبة.', 140),
    (8, 'mcq', 'ما الميزة الأهم لأنظمة الخلط اللوني الفوري (Tinting Systems) داخل معارض الدهانات المعتمدة؟', '1', NULL, 10.00, 'إجابة صحيحة.', 40),
    (9, 'text', 'اذكر أبرز إنجاز بيعي حققته سابقاً مع توضيح الأرقام...', 'نجحت في اعتماد وتوريد نظام دهانات داخلية وخارجية لمجمع سكني يضم 120 فيلا في شمال جدة بقيمة عقد 640,000 ريال بعد منافسة مع 3 موردين عبر إثبات تفوق معدل التغطية في العينة الميدانية، وحققت 118% من مستهدفي السنوي.', NULL, 9.50, 'إنجاز موثق بأرقام واضحة ومنهجية بيع فنية مقنعة.', 130),
    (10, 'portfolio', 'أرفق نموذج عرض سعر فني/تجاري سابق أو ملخص عرض بيعي مقترح...', 'مرفق نموذج هيكل عرض فني ومالي متكامل يتضمن جدول التغطية بالمتر المربع، شروط الدفع، والضمان الفني 10 سنوات.', '/uploads/samples/Sara_Sample_Proposal.pdf', 9.50, 'نموذج عرض احترافي منظم يربط المواصفات الفنية بشروط التوريد.', 115)
) AS q(idx, qtype, qtext, ans, att, pts, fb, sec)
WHERE a.reference_no = 'APP-2026-1001'
ON CONFLICT (application_id, question_index) DO NOTHING;

-- 6. تقييمات أعضاء لجنة التوظيف (تُفعّل التريجر تلقائياً لحساب 40% AI + 60% لجنة!)
INSERT INTO committee_evaluations (
    application_id, evaluator_name, evaluator_role,
    technical_competence, communication_persuasion, problem_solving, cultural_fit, portfolio_practical,
    recommendation, notes
)
SELECT
    a.id,
    'م. طارق السبيعي',
    'مدير المبيعات الإقليمي',
    4.8, 4.7, 4.5, 4.6, 4.5,
    'strong_hire',
    'تتمتع بخبرة ممتازة في مبيعات المشاريع بجدة وإلمام دقيق بحسابات التغطية والاعتمادات الهندسية.'
FROM applications a WHERE a.reference_no = 'APP-2026-1001'
ON CONFLICT (application_id, evaluator_name) DO NOTHING;

INSERT INTO committee_evaluations (
    application_id, evaluator_name, evaluator_role,
    technical_competence, communication_persuasion, problem_solving, cultural_fit, portfolio_practical,
    recommendation, notes
)
SELECT
    a.id,
    'أ. لمى الدوسري',
    'شريك أعمال الموارد البشرية',
    4.5, 4.8, 4.4, 4.7, 4.4,
    'strong_hire',
    'حضور مهني راقٍ ومهارات تفاوض واتصال عالية جداً وتوافق ممتاز مع قيم الشركة.'
FROM applications a WHERE a.reference_no = 'APP-2026-1001'
ON CONFLICT (application_id, evaluator_name) DO NOTHING;

INSERT INTO committee_evaluations (
    application_id, evaluator_name, evaluator_role,
    technical_competence, communication_persuasion, problem_solving, cultural_fit, portfolio_practical,
    recommendation, notes
)
SELECT
    a.id,
    'م. طارق السبيعي',
    'مدير المبيعات الإقليمي',
    4.2, 4.5, 4.1, 4.4, 4.3,
    'hire',
    'متميزة جداً في قطاع المعارض وأنظمة التلوين الفوري.'
FROM applications a WHERE a.reference_no = 'APP-2026-1002'
ON CONFLICT (application_id, evaluator_name) DO NOTHING;

INSERT INTO committee_evaluations (
    application_id, evaluator_name, evaluator_role,
    technical_competence, communication_persuasion, problem_solving, cultural_fit, portfolio_practical,
    recommendation, notes
)
SELECT
    a.id,
    'م. عادل الغامدي',
    'مدير المصنع والإنتاج',
    4.6, 4.2, 4.5, 4.5, 4.4,
    'strong_hire',
    'خلفية هندسية قوية في مصانع الدهانات ومعرفة عملية ممتازة بضبط اللزوجة وتقليل الفاقد.'
FROM applications a WHERE a.reference_no = 'APP-2026-1003'
ON CONFLICT (application_id, evaluator_name) DO NOTHING;

INSERT INTO committee_evaluations (
    application_id, evaluator_name, evaluator_role,
    technical_competence, communication_persuasion, problem_solving, cultural_fit, portfolio_practical,
    recommendation, notes
)
SELECT
    a.id,
    'د. سامي الحازمي',
    'مدير الجودة والمختبرات',
    4.3, 4.0, 4.2, 4.4, 4.1,
    'hire',
    'دقيقة في الفحوصات القياسية ولوائح SASO.'
FROM applications a WHERE a.reference_no = 'APP-2026-1005'
ON CONFLICT (application_id, evaluator_name) DO NOTHING;

-- مزامنة الدرجات المبدئية للطلبات التي لم تُقيّم من اللجنة بعد
SELECT fn_sync_application_weighted_score(id) FROM applications;

-- 7. جدولة المقابلات لليوم والغد (تظهر حية في لوحة التحكم وطابور الواتساب)
INSERT INTO interviews (
    application_id, scheduled_date, start_time, end_time, duration_minutes,
    meeting_platform, meeting_url, interviewer_panel, booking_status, notes
)
SELECT
    a.id,
    CURRENT_DATE,
    '10:00'::time,
    '10:30'::time,
    30,
    'Google Meet',
    'https://meet.google.com/ruw-sl20-sra',
    'م. طارق السبيعي + أ. لمى الدوسري',
    'confirmed',
    'مقابلة المرشحة الأولى لوظيفة مندوب مبيعات حلول الدهانات SL-204'
FROM applications a WHERE a.reference_no = 'APP-2026-1001'
ON CONFLICT (application_id) DO NOTHING;

INSERT INTO interviews (
    application_id, scheduled_date, start_time, end_time, duration_minutes,
    meeting_platform, meeting_url, interviewer_panel, booking_status, notes
)
SELECT
    a.id,
    CURRENT_DATE,
    '11:00'::time,
    '11:30'::time,
    30,
    'Google Meet',
    'https://meet.google.com/ruw-pt10-fhd',
    'م. عادل الغامدي + أ. لمى الدوسري',
    'invitation_sent',
    'مقابلة فنية لوظيفة مهندس إنتاج وخلط ألوان PT-101'
FROM applications a WHERE a.reference_no = 'APP-2026-1003'
ON CONFLICT (application_id) DO NOTHING;

INSERT INTO interviews (
    application_id, scheduled_date, start_time, end_time, duration_minutes,
    meeting_platform, meeting_url, interviewer_panel, booking_status, notes
)
SELECT
    a.id,
    CURRENT_DATE,
    '13:30'::time,
    '14:00'::time,
    30,
    'Google Meet',
    'https://meet.google.com/ruw-qc10-rem',
    'د. سامي الحازمي + أ. لمى الدوسري',
    'scheduled',
    'مقابلة ما بعد استراحة صلاة الظهر — وظيفة أخصائي مختبر QC-105'
FROM applications a WHERE a.reference_no = 'APP-2026-1005'
ON CONFLICT (application_id) DO NOTHING;

-- 8. طابور رسائل واتساب الهجينة (wa_messages) بروابط wa.me حقيقية وجاهزة
INSERT INTO wa_messages (
    application_id, interview_id, template_key, recipient_name, recipient_phone,
    message_body, wa_link, queue_status, sent_by, sent_at
)
SELECT
    a.id,
    i.id,
    'interview_invite',
    c.full_name,
    c.phone,
    'السلام عليكم أ. سارة بنت عبدالله الغامدي، نبارك لك اجتياز التقييم الأولي لوظيفة (مندوب مبيعات حلول الدهانات المعمارية والصناعية - SL-204) لدى شركة رُواء للدهانات. يسعدنا دعوتك للمقابلة اليوم الساعة 10:00 صباحاً عبر Google Meet: https://meet.google.com/ruw-sl20-sra — نرجو الرد بكلمة (تأكيد).',
    'https://wa.me/966551234567?text=' || '%D8%A7%D9%84%D8%B3%D9%84%D8%A7%D9%85%20%D8%B9%D9%84%D9%8A%D9%83%D9%85%20%D8%A3.%20%D8%B3%D8%A7%D8%B1%D8%A9%D8%8C%20%D9%86%D8%A8%D8%A7%D8%B1%D9%83%20%D9%84%D9%83%20%D8%A7%D8%AC%D8%AA%D9%8A%D8%A7%D8%B2%20%D8%A7%D9%84%D8%AA%D9%82%D9%8A%D9%8A%D9%85%20%D9%84%D9%88%D8%B8%D9%8A%D9%81%D8%A9%20SL-204%20%D9%88%D9%86%D8%AF%D8%B9%D9%88%D9%83%20%D9%84%D9%84%D9%85%D9%82%D8%A7%D8%A8%D9%84%D8%A9%20%D8%A7%D9%84%D8%B3%D8%A7%D8%B9%D8%A9%2010%3A00%20%D8%B9%D8%A8%D8%B1%20https%3A%2F%2Fmeet.google.com%2Fruw-sl20-sra',
    'confirmed',
    'أ. لمى الدوسري',
    NOW() - INTERVAL '1 day'
FROM applications a
JOIN candidates c ON c.id = a.candidate_id
JOIN interviews i ON i.application_id = a.id
WHERE a.reference_no = 'APP-2026-1001'
  AND NOT EXISTS (SELECT 1 FROM wa_messages wm WHERE wm.application_id = a.id);

INSERT INTO wa_messages (
    application_id, interview_id, template_key, recipient_name, recipient_phone,
    message_body, wa_link, queue_status, sent_by, sent_at
)
SELECT
    a.id,
    i.id,
    'interview_invite',
    c.full_name,
    c.phone,
    'السلام عليكم م. فهد بن سالم القحطاني، نبارك لك اجتياز التقييم الأولي لوظيفة (مهندس إنتاج وخلط ألوان صناعية - PT-101) لدى شركة رُواء للدهانات. موعد مقابلتك اليوم الساعة 11:00 صباحاً عبر Google Meet: https://meet.google.com/ruw-pt10-fhd',
    'https://wa.me/966543218765?text=' || '%D8%A7%D9%84%D8%B3%D9%84%D8%A7%D9%85%20%D8%B9%D9%84%D9%8A%D9%83%D9%85%20%D9%85.%20%D9%81%D9%87%D8%AF%D8%8C%20%D9%85%D9%88%D8%B9%D8%AF%20%D9%85%D9%82%D8%A7%D8%A8%D9%84%D8%AA%D9%83%20%D9%84%D9%88%D8%B8%D9%8A%D9%81%D8%A9%20PT-101%20%D8%A7%D9%84%D9%8A%D9%88%D9%85%20%D8%A7%D9%84%D8%B3%D8%A7%D8%B9%D8%A9%2011%3A00%20%D8%B9%D8%A8%D8%B1%20https%3A%2F%2Fmeet.google.com%2Fruw-pt10-fhd',
    'sent',
    'أ. لمى الدوسري',
    NOW() - INTERVAL '5 hours'
FROM applications a
JOIN candidates c ON c.id = a.candidate_id
JOIN interviews i ON i.application_id = a.id
WHERE a.reference_no = 'APP-2026-1003'
  AND NOT EXISTS (SELECT 1 FROM wa_messages wm WHERE wm.application_id = a.id);

INSERT INTO wa_messages (
    application_id, interview_id, template_key, recipient_name, recipient_phone,
    message_body, wa_link, queue_status
)
SELECT
    a.id,
    i.id,
    'interview_invite',
    c.full_name,
    c.phone,
    'السلام عليكم أ. ريم بنت طلال العتيبي، نبارك لك اجتياز التقييم الأولي لوظيفة (أخصائي مختبر وضبط جودة الطلاءات - QC-105) لدى شركة رُواء للدهانات. يسعدنا دعوتك للمقابلة اليوم الساعة 01:30 ظهراً عبر Google Meet: https://meet.google.com/ruw-qc10-rem — نرجو الرد بكلمة (تأكيد).',
    'https://wa.me/966534567890?text=' || '%D8%A7%D9%84%D8%B3%D9%84%D8%A7%D9%85%20%D8%B9%D9%84%D9%8A%D9%83%D9%85%20%D8%A3.%20%D8%B1%D9%8A%D9%85%D8%8C%20%D9%86%D8%AF%D8%B9%D9%88%D9%83%20%D9%84%D9%85%D9%82%D8%A7%D8%A8%D9%84%D8%A9%20%D9%88%D8%B8%D9%8A%D9%81%D8%A9%20QC-105%20%D8%A7%D9%84%D9%8A%D9%88%D9%85%20%D8%A7%D9%84%D8%B3%D8%A7%D8%B9%D8%A9%2013%3A30%20%D8%B9%D8%A8%D8%B1%20https%3A%2F%2Fmeet.google.com%2Fruw-qc10-rem',
    'queued'
FROM applications a
JOIN candidates c ON c.id = a.candidate_id
JOIN interviews i ON i.application_id = a.id
WHERE a.reference_no = 'APP-2026-1005'
  AND NOT EXISTS (SELECT 1 FROM wa_messages wm WHERE wm.application_id = a.id);

-- 9. سجل التدقيق والحوكمة الأولي (audit_logs)
INSERT INTO audit_logs (actor, actor_role, action, entity_type, entity_id, metadata, ip_address)
SELECT 'النظام التلقائي', 'system', 'DB_SCHEMA_INITIALIZED', 'database', 'smart_hr_db',
       '{"tables": 9, "jobs_seeded": 5, "blind_screening": true}'::jsonb, '127.0.0.1'
WHERE NOT EXISTS (SELECT 1 FROM audit_logs WHERE action = 'DB_SCHEMA_INITIALIZED');

INSERT INTO audit_logs (actor, actor_role, action, entity_type, entity_id, metadata, ip_address)
SELECT 'محرك التحليل الذكي', 'ai_engine', 'ASSESSMENT_GRADED_BLIND', 'application', 'APP-2026-1001',
       '{"score": 88.2, "integrity": 96, "status": "passed_assessment"}'::jsonb, '127.0.0.1'
WHERE NOT EXISTS (SELECT 1 FROM audit_logs WHERE entity_id = 'APP-2026-1001' AND action = 'ASSESSMENT_GRADED_BLIND');

INSERT INTO audit_logs (actor, actor_role, action, entity_type, entity_id, metadata, ip_address)
SELECT 'م. طارق السبيعي', 'committee_member', 'COMMITTEE_EVALUATION_SAVED', 'application', 'APP-2026-1001',
       '{"weighted_criteria": 5, "recommendation": "strong_hire"}'::jsonb, '10.0.1.15'
WHERE NOT EXISTS (SELECT 1 FROM audit_logs WHERE entity_id = 'APP-2026-1001' AND action = 'COMMITTEE_EVALUATION_SAVED');

COMMIT;
