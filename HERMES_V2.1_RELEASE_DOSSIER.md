# ملف المراجعة الهندسية المحدّث — معالجة ملاحظات المراجعة الأربع للإصدار `v2.1`
**موجه إلى:** وكيل المراجعة التقنية والبنية التحتية **Hermes** (بقيادة واعتماد **عبدالرحمن**)  
**المشروع:** منصة التوظيف الذكية (`https://hrjpf.tech` — المسار `/opt/jpf-job` على `srv1924474`)  
**طلب الدمج المفتوح:** `https://github.com/abdulrhmanbashniny-jpg/jpf-job/pull/1` (`release/v2.1` -> `main`)  
**حالة النشر:** قيد إعادة المراجعة الفنية — **لا نشر ولا إعادة تشغيل للحاويات قبل موافقة عبدالرحمن الصريحة.**

---

## ملخص معالجة النقاط الأربع التي رصدها Hermes

### 1. الحفاظ الكامل على مفاتيح وقيم `whatsapp_templates` الحالية (بدل استبدال الكائن)
* **المعالجة في `database/db.js`:**
  * استُبدل بناء الكائن الجزئي بدمج JSONB ذري يحفظ كافة المفاتيح والقيم الموجودة على اليمين (`existing` يغلب `defaults`):
    ```sql
    INSERT INTO system_settings (setting_key, setting_value, category, description, updated_by)
    VALUES ('whatsapp_templates', $1::jsonb, 'whatsapp_templates', 'قوالب رسائل واتساب الهجينة للمراحل المعتمدة', 'system')
    ON CONFLICT (setting_key) DO UPDATE
      SET setting_value = $1::jsonb || COALESCE(system_settings.setting_value, '{}'::jsonb)
      WHERE NOT (COALESCE(system_settings.setting_value, '{}'::jsonb) ?& ARRAY[
        'interview_invite','interview_inperson','confirm_booking','reminder_day_before',
        'send_room_now','thank_followup','pass_notification','reschedule_notice'
      ]);
    ```
* **المعالجة في `PUT /api/wa-templates` (`server.js`):**
  * يحدّث المفتاح المعدّل فقط عبر `COALESCE(system_settings.setting_value, '{}'::jsonb) || $1::jsonb` دون المساس ببقية المفاتيح (`pass_notification`, `reschedule_notice`, أو أي مفاتيح مخصصة في الإنتاج).

---

### 2. حماية بطاقة الزيارة وتأكيد الحضور برمز غير قابل للتخمين ومقيّد بالغرض + إغلاق كشف التقرير في المسار العام الموروث
* **مفاتيح توقيع مفصولة حسب الغرض (`Purpose-Separated HMAC-SHA256` في `services/auth.js` + `256-bit DB Nonces`):**
  * يشتق `getPurposeKey(purpose)` مفتاح توقيع مستقلاً لكل غرض (`visit_pass` مقابل `candidate_portal` مقابل `staff_session`) مع مقارنة زمنية ثابتة `crypto.timingSafeEqual`.
* **أ. حماية بطاقة الزيارة وتأكيد الحضور (`visit_pass`):**
  * أُضيف عمود `visit_token VARCHAR(64) NOT NULL` بفهرس فريد (`idx_interviews_visit_token`) في جدول `interviews`.
  * أصبحت الروابط المولّدة للمرشح بصيغة `Visit.dc.html?vt=<HMAC_TOKEN>` (`GET /api/public/visit/:vt` و `POST /api/public/visit/:vt/confirm`).
  * تمرير الرقم المرجعي المتسلسل `APP-2026-XXXX` أو تمرير رمز من غرض آخر (`candidate_portal`) يُرفض فوراً بكود **`403 Forbidden`**.
* **ب. إغلاق كشف التقرير والبيانات الشخصية في المسار العام الموروث (`GET /api/applications/:idOrRef`):**
  * أُضيف عمود `candidate_access_token VARCHAR(64) NOT NULL` في جدول `applications`.
  * عند تقديم الطلب (`POST /api/applications`) أو التحقق من الملكية عبر المسار المقيّد بمعدل المحاولات `POST /api/public/candidate-verify` (مطابقة الرقم المرجعي + رقم الجوال أو البريد المسجل)، يُصدر الخادم كوكي `HttpOnly; SameSite=Lax` باسم `jpf_cand_session` مقيّداً بغرض `candidate_portal`.
  * أي استعلام غير موثق من الجمهور على `/api/applications/1` يرجع **`401`**، وعلى `/api/applications/APP-2026-1001` أو `/api/assessments/status/APP-2026-1001` أو `/api/assessments/submit` بدون رمز المتقدم الصالح يرجع **`403`** دون تسريب أي حقل.
  * **تقليص البيانات (`Data Minimization`) حتى للمتقدم الموثق:** تُحجب تماماً الحقول الداخلية للجنة (`email`, `phone`, `cv_stored_path`, `cv_extracted_text`, `committee_avg_score`, `final_weighted_score`, `tab_switches`, `paste_attempts`, وداخل `ai_report` يُحجب `blind_summary` و `risks` و `cv_breakdown` و `question_breakdown` ويُقتصر العرض على `strengths` و `gaps` الموجهة للمتقدم فقط).

---

### 3. الفصل الصارم بين «جاهزة للإرسال / فُتح الرابط كمسودة» و«تأكد إرسالها فعلياً»
* أُضيف عمود `prepared_at TIMESTAMPTZ` إلى جدول `wa_messages` (في كلٍّ من الترحيل ومخطط التأسيس).
* عند الجدولة من `Ranking.dc.html` (`open_draft: true`) أو النقر على **«💬 فتح مسودة»** في `Interviews.dc.html` (`PATCH /api/wa-messages/:id` بـ `action: 'open_draft'`):
  * **لا تتحول** `queue_status` إلى `'sent'`، ويبقى `sent_at = NULL`، وتبقى المقابلة في حالة `'scheduled'`، بينما يُسجَّل `prepared_at = NOW()` وتظهر شارة **«فُتح الرابط — بانتظار التأكيد»** مع تسجيل حدث تدقيق `WA_DRAFT_OPENED`.
* فقط عند ضغط المنسق صراحةً على زر **«✓ تأكيد الإرسال»** (`action: 'confirm_sent'`) بعد إرسال الرسالة فعلياً داخل واتساب:
  * تتحول `queue_status` إلى `'sent'`، ويُسجَّل `sent_at = NOW()` واسم المرسِل `sent_by`، وتنتقل حالة المقابلة إلى `'invitation_sent'` مع حدث تدقيق `WA_SEND_CONFIRMED`.

---

### 4. توحيد تعريفات الأعمدة (100%)، تصحيح `pg_dump` وهوية المستخدم، ونتائج التجارب الفعلية المقاسة

#### أ. توحيد الأعمدة بين `database/db.js` و `database/schema_and_seed.sql`:
تمت مطابقة كافة الأنواع والأطوال والقيود والـ `DEFAULT` حرفياً عبر `139 عموداً` في الجداول الـ 11 (فارق `0` في `information_schema.columns`):
* `candidates.specialization`: `VARCHAR(150) NOT NULL DEFAULT ''`
* `applications.ai_analysis_status`: `VARCHAR(30) NOT NULL DEFAULT 'completed'`
* `applications.candidate_access_token`: `VARCHAR(64) NOT NULL DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))`
* `interviews.interview_mode`: `VARCHAR(24) NOT NULL DEFAULT 'remote'`
* `interviews.visit_token`: `VARCHAR(64) NOT NULL DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))` (+ `UNIQUE INDEX idx_interviews_visit_token`)
* `interviews.location_building`: `VARCHAR(220)` | `location_floor`: `VARCHAR(80)` | `location_office`: `VARCHAR(80)` | `location_maps_url`, `location_image_url`, `location_notes`: `TEXT`
* `wa_messages.prepared_at`: `TIMESTAMPTZ`
* *ملاحظة هندسية للرجوع:* وجود `DEFAULT` على مستوى PostgreSQL لكل عمود `NOT NULL` جديد يضمن نجاح جمل `INSERT` في كود `v2.0` (`70be659`) حتى على القاعدة المرحّلة دون الحاجة لحذف الأعمدة أو استعادة القاعدة.

#### ب. تصحيح أمر `pg_dump` وهوية مستخدم القاعدة على الخادم:
في `docker-compose.yml` المستخدم الافتراضي هو `${POSTGRES_USER:-smart_hr_user}` (أو القيمة المحددة في `/opt/jpf-job/.env` والممررة لبيئة حاوية `db` الداخلية). لتفادي خطأ توسعة المتغير في صدفة المضيف (`Host Shell`)، يُقرأ المتغير **من داخل حاوية `db` نفسها**:
```bash
mkdir -p /root/backups/smarthr
TS=$(date +%F_%H%M%S)

# قراءة POSTGRES_USER و POSTGRES_DB الفعليين من بيئة حاوية db مباشرة
docker compose -f /opt/jpf-job/docker-compose.yml -f /opt/jpf-job/docker-compose.override.yml \
  exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "/root/backups/smarthr/db_pre_v21_${TS}.dump"

# التحقق الفوري من سلامة ملف النسخة الاحتياطية وقائمة محتوياته (بدون تعديل القاعدة)
docker compose -f /opt/jpf-job/docker-compose.yml -f /opt/jpf-job/docker-compose.override.yml \
  exec -T db pg_restore --list < "/root/backups/smarthr/db_pre_v21_${TS}.dump" | head -n 25
```

#### ج. نتائج الاختبارات والتجارب الأربع المقاسة فعلياً (`npm run verify:v21` — `scripts/verify-v21-drills.js`):
أُضيف السكربت القابل لإعادة التشغيل `scripts/verify-v21-drills.js` إلى المستودع، ونُفّذ فعلياً على `PostgreSQL 17.11` + `Node.js 20.20` مسجّلاً القياسات الحقيقية التالية:

1. **تجربة ترقية قاعدة `v2.0` مأهولة (`70be659 -> v2.1`):**
   * تهيئة قاعدة من `git show 70be659:database/schema_and_seed.sql` (`5` وظائف، `6` مرشحين، `6` طلبات، `3` مقابلات) مع تعديل مخصص لقالب `interview_invite` وإضافة مفتاح مخصص `custom_hr_special`.
   * زمن تنفيذ الترحيل المقاس: **`244ms`**.
   * النتيجة: تطابق كامل في عدد الصفوف، الحفاظ على جميع الـ `9` مفاتيح في `whatsapp_templates` دون استبدال القيم المخصصة، وتطابق **`139 / 139` عموداً (`0` اختلاف)** مع قاعدة `v2.1` مهيأة من الصفر.
2. **تجربة التحقق الأمني وعزل الأغراض وحالات واتساب:**
   * رفض `/api/applications/1` (`401`)، ورفض `/api/applications/APP-2026-1001` بدون رمز المتقدم (`403`)، ورفض `/api/public/visit/APP-2026-1001` (`403`)، ورفض تبادل الرموز بين `candidate_portal` و `visit_pass` (`403`).
   * زمن استجابة إرسال الاختبار (`POST /api/assessments/submit`): **`22ms`**.
   * ثبوت بقاء الرسالة `queued` مع تعبئة `prepared_at` وبقاء `sent_at = null` عند فتح المسودة، وعدم التحول إلى `sent` و `invitation_sent` إلا بعد استدعاء `confirm_sent`.
3. **تجربة النسخ الاحتياطي والاستعادة المعزولة (`Isolated Backup & Restore`):**
   * أخذ `pg_dump -Fc` للقاعدة المأهولة بعد إدراج بيانات `v2.1` جديدة: **`110ms`** (الحجم: `66 KB`).
   * استعادتها عبر `pg_restore --no-owner --no-privileges` في قاعدة معزولة `drill_restore_isolated`: **`105ms`** مع تطابق تام في كافة السجلات (`7` مرشحين، `7` طلبات، `4` مقابلات).
4. **تجربة الرجوع الفعلية (`Actual Rollback Drill: v2.1 -> 70be659 v2.0`):**
   * استخراج كود الإنتاج الحالي `git archive 70be659` وتشغيله مباشرةً على القاعدة المرحّلة إلى `v2.1` والمحتوية على طلب ومقابلة حضورية ومرفقات `uploads` أُنشئت في `v2.1`.
   * زمن إقلاع خادم `v2.0` Node على القاعدة المرحّلة: **`154ms`**، استجاب `/api/health` بـ `ok`، ونجح كود `v2.0` في تنفيذ `POST /api/applications` جديد (`201 Created`) ورفع ملف سيرة إلى `uploads` دون أي تعارض مع أعمدة `v2.1`.
   * *(ملاحظة تشغيلية: زمن إعادة بناء وتشغيل حاوية Docker `docker compose up -d --build app` على الخادم `srv1924474` يعتمد على سرعة المعالج وتخزين Docker المؤقت على الخادم نفسه، ويُقاس ميدانياً من قِبل Hermes أثناء التنفيذ المعتمد بدلاً من افتراض زمن ثابت).*

---

## 5. خطوات الرجوع المعتمدة للخادم (تراعي القاعدة و `uploads_data` و `override`)

1. **الرجوع السريع للكود (دون مساس بالطلبات الجديدة أو ملفات `uploads_data` أو `docker-compose.override.yml`):**
   ```bash
   cd /opt/jpf-job
   git checkout 70be659
   cp /root/backups/smarthr/aiEvaluator_pre_v21_*.js /opt/jpf-job/services/aiEvaluator.js
   docker compose up -d --build app
   curl -fsS https://hrjpf.tech/api/health
   ```
   *(مجرّب فعلياً في Drill 4؛ ملفات السير الذاتية في الـ Volume المسمى `uploads_data` تبقى متاحة، وصور `/uploads/public` الإضافية تبقى خاملة بأمان دون تأثير على `v2.0`).*

2. **استعادة القاعدة المعزولة أولاً عند الطوارئ القصوى (قبل أي مساس بقاعدة الإنتاج):**
   ```bash
   # اختبار الاستعادة في قاعدة مؤقتة معزولة داخل نفس الحاوية للتحقق قبل التبديل
   docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS smart_hr_restore_verify; CREATE DATABASE smart_hr_restore_verify;"'
   docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d smart_hr_restore_verify --no-owner --no-privileges' < /root/backups/smarthr/db_pre_v21_*.dump
   ```
