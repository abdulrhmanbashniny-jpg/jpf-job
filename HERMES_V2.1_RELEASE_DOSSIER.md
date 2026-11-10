# ملف المراجعة الهندسية والأمنية النهائي الموحّد — الإصدار `v2.1`
**موجه إلى:** وكيل المراجعة التقنية والبنية التحتية **Hermes** (بقيادة واعتماد **عبدالرحمن**)  
**المشروع:** منصة التوظيف الذكية (`https://hrjpf.tech` — المسار `/opt/jpf-job` على `srv1924474`)  
**طلب الدمج المفتوح:** `https://github.com/abdulrhmanbashniny-jpg/jpf-job/pull/1` (`release/v2.1` -> `main`)  
**حالة النشر:** دفعة نهائية موحّدة (Final Cohesive `v2.1` Commit) للمراجعة النهائية لعوائق الإطلاق فقط — **لا دمج ولا نشر ولا إعادة تشغيل للحاويات قبل موافقة عبدالرحمن الصريحة.**

---

## ملخص معالجة العوائق الأربعة المرصودة في مراجعة الجولة الثانية

### 1. إغلاق استعادة طلب شخص آخر وإثبات حيازة الطلب تشفيرياً (`Proof-of-Possession`)
* **أ. إغلاق ثغرة استئناف الطلب أو تعديل سجل مرشح في `POST /api/applications`:**
  * عند تطابق جزئي للبريد أو الجوال مع سجل مرشح آخر (`email` فقط أو `phone` فقط)، يُرفض الطلب فوراً بكود **`409 Conflict` (`CANDIDATE_CONTACT_CONFLICT`)** مع حذف الملف المؤقت المرفوع دون كشف أي `reference_no` أو إصدار أي كوكي.
  * حتى عند تطابق البريد والجوال معاً لمرشح مسجل مسبقاً، **لا يُسمح** باستئناف اختبار معلق (`assessment_pending`) ولا بالتقديم على وظيفة ثانية أو تحديث سجل المرشح إلا إذا أثبت المرسل حيازته التشفيرية عبر كوكي الجلسة الأصلي `jpf_cand_session` أو تمرير **مفتاح الدخول السري `access_key` (100-bit HMAC-SHA256، بصيغة `JPFK-XXXX-XXXX-XXXX-XXXX`)**؛ وبدون ذلك يُرفض الطلب بكود **`403 Forbidden` (`CANDIDATE_OWNERSHIP_PROOF_REQUIRED`)** دون إصدار أي توكن أو تسريب الرقم المرجعي.
* **ب. إغلاق التحقق المعرفي البسيط في `POST /api/public/candidate-verify` + مسار استعادة القناة المسجلة:**
  * حُذف قبول البريد الإلكتروني أو رقم الجوال في `POST /api/public/candidate-verify` بالكامل (`400 ACCESS_KEY_REQUIRED`)، وأصبح المسار يشترط التحقق الزمني الثابت (`crypto.timingSafeEqual`) من **مفتاح الدخول السري `access_key`** المشتق بمفتاح غرض مستقل `candidate_access_key` من `candidate_access_token` (256-bit).
  * عند فقدان المتقدم لمفتاحه السري، أُضيف مسار محمي بصلاحيات الموارد البشرية `POST /api/applications/:id/recovery-link` يقوم **بتدويـر `candidate_access_token`** (مما يُبطل فوراً أي مفتاح أو كوكي قديم `403`) ويُدرج مسودة رسالة `queued` في `wa_messages` موجّهة **حصراً إلى رقم الجوال المسجل في جدول `candidates` بقاعدة البيانات** دون قبول أي رقم خارجي.

---

### 2. اتساق انتقالات حالات واتساب وتدوير رموز الزيارة عند إعادة الجدولة أو الإلغاء
* **أ. منع انتقال الرسائل غير المرسلة (`queued`) إلى `confirmed`:**
  * في `POST /api/public/visit/:vt/confirm`: لا يُسمح بتأكيد حضور الموعد إذا لم تُرسل دعوته فعلياً بعد (`booking_status` في حالة `scheduled` أو `rescheduled` يرجع **`409 Conflict` — `INVITATION_NOT_SENT_YET`**)، وعند التأكيد الشرعي تُحدَّث **فقط** الرسائل ذات الحالة `queue_status = 'sent'` إلى `'confirmed'`، بينما تبقى أي رسائل أخرى في حالة `'queued'` كما هي دون مساس.
  * في `PATCH /api/wa-messages/:id`: يُرفض تحويل أي رسالة ما زالت `queued` مباشرةً إلى `confirmed` بكود **`400` (`CANNOT_CONFIRM_UNSENT_MESSAGE`)**.
* **ب. تدوير رمز الزيارة وإبطال الدعوات والرسائل السابقة عند إعادة الجدولة أو الإلغاء:**
  * في المسارات الثلاثة (`POST /api/interviews/schedule-single` عند وجود موعد سابق، و `POST /api/interviews/auto-schedule` عند التعارض، و `PATCH /api/interviews/:id` عند تعديل التاريخ/الوقت/النمط أو الإلغاء):
    1. يُولَّد **`visit_token` عشوائي جديد (256-bit CSPRNG)** في جدول `interviews`، فيصبح أي رابط زيارة قديم `?vt=...` ملغى فوراً ويرجع **`403 Forbidden` (`REVOKED_VISIT_TOKEN`)** على كلٍّ من العرض وتأكيد الحضور.
    2. تُبطَل جميع رسائل واتساب السابقة المرتبطة بذلك الموعد (`UPDATE wa_messages SET queue_status = 'cancelled' WHERE interview_id = $1 AND queue_status IN ('queued', 'sent', 'confirmed')`)، ويُمنع إعادة إرسال أي رسالة ملغاة (`400 WA_MESSAGE_CANCELLED`)، وتُنشأ مسودة دعوة جديدة بحالة `'queued'` تحمل الرابط الجديد.
* **ج. معالجة نقاط الجولة الثالثة (عزل أسرار الاستعادة + حفظ نصوص المسودات + التزامن الذري `FOR UPDATE`):**
  1. **عزل أسرار الاستعادة بصلاحيات RBAC (`server.js`):** حُصرت قراءة وتعديل وإنشاء رسائل `portal_recovery` في `GET /api/wa-messages` و `POST /api/wa-messages` و `PATCH /api/wa-messages/:id` بدورَي `super_admin` و `hr_coordinator` فقط (ويُستبعد `committee_member` منها بفلتر SQL وبكود `403 FORBIDDEN_ROLE` عند محاولة الوصول المباشر)، كما حُجبت الأعمدة الخام `candidate_access_token` و `visit_token` من جميع ردود `GET /api/applications` و `GET /api/applications/:idOrRef`.
  2. **حماية نصوص المسودات (`portal_recovery` و `reschedule_notice`) من الاستبدال (`public/Interviews.dc.html` + `server.js`):** أُضيفت قوالب `reschedule_notice` و `pass_notification` إلى قائمة `TEMPLATE_STAGES`، وأُقفل صف `portal_recovery` بشارة محمية بدون قائمة استبدال، وعدّلت دالة `resolveDraftPayload` بحيث تحافظ تماماً على `item.message_body` الأصلي (بما فيه رابط الاستعادة ومفتاح `JPFK-...` أو رمز `vt` الجديد) ما لم يغيّر الموظف القالب يدوياً في رسالة مقابلة عادية، مع حماية إضافية في الخادم تمنع الكتابة فوق نص `portal_recovery`.
  3. **قفل انتقالات حالة الموعد والتحديث الذري المتزامن (`PATCH /api/interviews/:id` + `POST /api/public/visit/:vt/confirm`):** مُنع تعيين `invitation_sent` أو `confirmed` مباشرةً من `PATCH /api/interviews/:id` (`400 INVALID_INTERVIEW_TRANSITION`) أو تسجيل `completed`/`no_show` قبل إرسال الدعوة، وحُوّل تأكيد الحضور `POST /api/public/visit/:vt/confirm` إلى معاملة PostgreSQL ذرية تقفل الصف بـ `SELECT ... FOR UPDATE OF i` وتنفذ `UPDATE interviews ... WHERE id = $1 AND LEFT(visit_token, 32) = $2 AND booking_status IN ('invitation_sent', 'confirmed')` لمنع أي سباق تزامن مع إعادة الجدولة (مُثبت باختبار سباق متزامن في `DRILL 2C` داخل `verify:v21`).

---

### 3. عزل سكربت الفحص `verify:v21` بحواجز أمان صارمة وتشغيله الفعلي داخل GitHub Actions CI
* **حواجز الأمان في `scripts/verify-v21-drills.js`:**
  * أُزيل تحميل `.env` وقراءة `DATABASE_URL` بالكامل من السكربت.
  * يرفض السكربت التشغيل فوراً (`exit 1`) إذا لم يُمرَّر `ALLOW_ISOLATED_DRILL=1`، أو إذا كانت `NODE_ENV=production`، أو إذا شُغّل داخل `/opt/jpf-job`، أو إذا لم يكن `DRILL_PG_ADMIN_URL` محلياً (`127.0.0.1` / `localhost`) وموجّهاً لقاعدة الصيانة `/postgres`.
  * ينشئ السكربت قواعد مؤقتة معزولة بلاحقة عشوائية (`jpf_iso_*`) ومجلد مرفقات مؤقت ومنفذين معزولين (`3091` و `3092`) ويزيلها بالكامل في كتلة `finally`.
* **التشغيل الآلي الموثق داخل `.github/workflows/ci.yml`:**
  * **المهمة الأولى (`verify-platform`):** تشغّل اختبار حواجز الأمان ثم تشغّل `npm run verify:v21` فعلياً على `PostgreSQL 17` وتطبع سجل الترقية ومطابقة `139/139` عموداً واختبارات الملكية وحالات واتساب والاستعادة في سجل CI العام.
  * **المهمة الثانية (`container-upgrade-rollback-drill`):** تشغّل `scripts/ci-container-rollback-drill.sh` لبناء حاويات `docker compose` حقيقية تحاكي الإنتاج (`70be659` + `docker-compose.override.yml` + ملف ترقيع `services/aiEvaluator.js` + حجمَي `pgdata` و `uploads_data`) وتنفذ النسخ الاحتياطي والترقية إلى `v2.1` والاستعادة المعزولة والرجوع الكامل للحاويات.

---

## 4. خطة النسخ الاحتياطي والاستعادة المعزولة والرجوع الكاملة على الخادم (تشمل القاعدة و `uploads_data` و `override` وملف الترقيع)

### أ. النسخ الاحتياطي الكامل قبل أي ترقية معتمدة:
```bash
mkdir -p /root/backups/smarthr
TS=$(date +%F_%H%M%S)
DC="docker compose -f /opt/jpf-job/docker-compose.yml -f /opt/jpf-job/docker-compose.override.yml"

# 1. حفظ نسخة من ملف الترقيع المحلي وملف override وملف البيئة
cp /opt/jpf-job/services/aiEvaluator.js "/root/backups/smarthr/aiEvaluator_pre_v21_${TS}.js"
cp /opt/jpf-job/docker-compose.override.yml "/root/backups/smarthr/docker-compose.override.pre_v21_${TS}.yml"
cp /opt/jpf-job/.env "/root/backups/smarthr/env_pre_v21_${TS}.bak"

# 2. نسخ احتياطي مضغوط لقاعدة البيانات باستخدام متغيرات بيئة حاوية db الداخلية
$DC exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "/root/backups/smarthr/db_pre_v21_${TS}.dump"

# 3. نسخ احتياطي كامل لحجم المرفقات المسمى (uploads_data) من داخل حاوية app مع حفظ البنية
$DC exec -T app sh -c 'tar -czf - -C /app/uploads .' \
  > "/root/backups/smarthr/uploads_pre_v21_${TS}.tar.gz"

# 4. التحقق الفوري غير التدميري من سلامة الأرشيفين (دون إغلاق مبكر للأنبوب تحت pipefail)
$DC exec -T db pg_restore --list < "/root/backups/smarthr/db_pre_v21_${TS}.dump" | wc -l
tar -tzf "/root/backups/smarthr/uploads_pre_v21_${TS}.tar.gz" | wc -l
```

### أ-2. الترقية النظيفة للكود بعد موافقة عبدالرحمن الصريحة (دون تعارض مع ملف الترقيع المتتبع ودون لمس `override` أو `.env`):
```bash
cd /opt/jpf-job
# بعد حفظ نسخة aiEvaluator_pre_v21_${TS}.js في الخطوة السابقة، يُعاد ضبط الملف المتتبع ليسمح Git بالترقية النظيفة
git checkout -- services/aiEvaluator.js
git fetch origin
git checkout main && git pull --ff-only origin main
docker compose -f /opt/jpf-job/docker-compose.yml -f /opt/jpf-job/docker-compose.override.yml up -d --build app
curl -fsS https://hrjpf.tech/api/health
```

### ب. اختبار الاستعادة المعزول داخل حاوية `db` (معاملَا `-c` منفصلان خارج كتلة المعاملة):
```bash
DC="docker compose -f /opt/jpf-job/docker-compose.yml -f /opt/jpf-job/docker-compose.override.yml"

# ملاحظة مهمة: تمرير -c مرتين منفصلتين يضمن تنفيذ DROP DATABASE و CREATE DATABASE خارج كتلة معاملة (Transaction Block)
$DC exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS smart_hr_restore_verify WITH (FORCE);" \
  -c "CREATE DATABASE smart_hr_restore_verify;"'

$DC exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d smart_hr_restore_verify --no-owner --no-privileges' \
  < "/root/backups/smarthr/db_pre_v21_${TS}.dump"

# حذف القاعدة المؤقتة بعد التحقق من سلامة الصفوف المستعادة
$DC exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS smart_hr_restore_verify WITH (FORCE);"'
```

### ج. المستوى الأول للرجوع (رجوع حاوية التطبيق إلى `70be659` مع الحفاظ على الطلبات والمرفقات الجديدة):
*(مُثبت ومُجرَّب آلياً في `scripts/ci-container-rollback-drill.sh` داخل CI — جميع أعمدة `NOT NULL` الجديدة في `v2.1` مزوّدة بـ `DEFAULT` على مستوى PostgreSQL بحيث يعمل كود `70be659` قراءةً وإدراجاً دون تعارض):*
```bash
cd /opt/jpf-job
git checkout 70be659
cp "/root/backups/smarthr/aiEvaluator_pre_v21_${TS}.js" /opt/jpf-job/services/aiEvaluator.js

# إعادة بناء حاوية app مع الإبقاء التام على docker-compose.override.yml و .env وحجمَي pgdata و uploads_data
docker compose -f /opt/jpf-job/docker-compose.yml -f /opt/jpf-job/docker-compose.override.yml up -d --build app
curl -fsS https://hrjpf.tech/api/health
```

### د. المستوى الثاني للرجوع عند الطوارئ القصوى (استعادة القاعدة + حجم `uploads_data` بالكامل إلى نقطة ما قبل الترقية):
*(لا يُنفَّذ إلا بقرار صريح من عبدالرحمن في حال رُغب في إلغاء التغييرات اللاحقة والعودة الكاملة لنقطة النسخة الاحتياطية):*
```bash
DC="docker compose -f /opt/jpf-job/docker-compose.yml -f /opt/jpf-job/docker-compose.override.yml"

# 1. التحقق أولاً من نجاح الاستعادة في القاعدة المعزولة smart_hr_restore_verify (الخطوة ب أعلاه)
# 2. إيقاف حاوية التطبيق مؤقتاً لمنع الاتصالات النشطة أثناء استبدال القاعدة والمرفقات
$DC stop app

# 3. إعادة إنشاء قاعدة الإنتاج واستعادة النسخة الاحتياطية (معاملَا -c منفصلان)
$DC exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE);" \
  -c "CREATE DATABASE \"$POSTGRES_DB\";"'
$DC exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges' \
  < "/root/backups/smarthr/db_pre_v21_${TS}.dump"

# 4. استرجاع كود 70be659 وملف الترقيع وتشغيل الحاوية ثم استعادة أرشيف المرفقات بصلاحيات المستخدم node
cd /opt/jpf-job
git checkout 70be659
cp "/root/backups/smarthr/aiEvaluator_pre_v21_${TS}.js" /opt/jpf-job/services/aiEvaluator.js
$DC up -d --build app
$DC exec -T app sh -c 'rm -rf /app/uploads/* && mkdir -p /app/uploads/samples && tar -xzf - -C /app/uploads' \
  < "/root/backups/smarthr/uploads_pre_v21_${TS}.tar.gz"
curl -fsS https://hrjpf.tech/api/health
```

---

## 5. التدقيق الشامل النهائي الموحّد (مصفوفات انتقالات الحالات، الأقفال الهرمية، الصلاحيات، المتصفح الفعلي، وما لم يُختبر)

### أ. مصفوفة انتقالات رسائل واتساب (`wa_messages`) ومنع التوليفات المتعارضة (`PATCH /api/wa-messages/:id`)
1. **رفض المعاملات المتعارضة من البوابة الأولى قبل لمس القاعدة:**
   * إرسال `action` و `queue_status` معاً في طلب واحد (مثل `{ action: 'confirm_sent', queue_status: 'cancelled' }` أو `{ action: 'open_draft', queue_status: 'cancelled' }`) يُرفض فوراً بكود **`400 CONFLICTING_WA_PARAMS`**.
   * إرسال قيمة `action` خارج `['open_draft', 'confirm_sent']` يُرفض بـ **`400 INVALID_WA_ACTION`**، وقيمة `queue_status` خارج القائمة المعتمدة تُرفض بـ **`400 INVALID_WA_STATUS`**، والطلب الفارغ يُرفض بـ **`400 EMPTY_WA_PATCH`**.
2. **القفل النهائي الصارم للحالة الملغاة (`cancelled`):**
   * أي صف في `wa_messages` حالته `cancelled` يُعد منتهياً نهائياً؛ وأي طلب `PATCH` عليه يرجع **`400 WA_MESSAGE_CANCELLED`** دون أي تعديل على الصف أو الموعد المرتبط.
3. **ترتيب الأقفال الهرمي الموحّد لمنع `AB-BA Deadlock`:**
   * تلتزم جميع المعاملات في النظام (`schedule-single`, `auto-schedule`, `PATCH /api/interviews/:id`, `POST /api/public/visit/:vt/confirm`, و `PATCH /api/wa-messages/:id`) بترتيب قفل واحد: **`applications` -> `interviews` -> `wa_messages` (`FOR UPDATE`)**.
4. **جدول الانتقالات المسموحة والممنوعة:**
   * `queued` + `action='open_draft'` -> يبقى `queued` مع تسجيل `prepared_at = NOW()` (لا يغيّر `interviews.booking_status`).
   * `queued` -> `sent` (`action='confirm_sent'` أو `queue_status='sent'`): مسموح فقط إذا لم يكن الموعد ملغى (`400 INTERVIEW_ALREADY_CANCELLED`) ولم تتجاوزه دعوة أحدث (`409 SUPERSEDED_WA_MESSAGE`)؛ ويُحدّث `interviews.booking_status` إلى `'invitation_sent'` **فقط** لرسائل الدعوة/التحديث النشطة (`interview_invite`, `interview_inperson`, `reschedule_notice`) عندما يكون الموعد في `scheduled` أو `rescheduled`.
   * `sent` -> `confirmed`: مسموح فقط لغير `portal_recovery` وبشرط أن يكون الموعد المرتبط في `invitation_sent` أو `confirmed`؛ ممنوع مباشرة من `queued` (`400 CANNOT_CONFIRM_UNSENT_MESSAGE`).
   * `queued` -> `failed` ثم `failed` -> `queued` (إعادة محاولة): مسموح؛ أما الرجوع من `sent` أو `confirmed` إلى `queued` أو تعديل `message_body` بعد الخروج من `queued` فمرفوض (`400 INVALID_WA_TRANSITION` / `400 SENT_BODY_IMMUTABLE`).
   * رسائل `portal_recovery`: يُمنع إنشاؤها عبر `POST /api/wa-messages` (`400`)، ويُمنع تعديل نصها (`400 RECOVERY_BODY_IMMUTABLE`)، وعند توليد رابط استعادة جديد عبر `POST /api/applications/:id/recovery-link` يُقفل صف الطلب `FOR UPDATE` وتُلغى جميع رسائل `portal_recovery` السابقة تلقائياً قبل إدراج المسودة الجديدة.

### ب. مصفوفة انتقالات المقابلات والطلبات المترابطة (`applications` <-> `interviews`)
* **أهلية الجدولة:** لا يُسمح بجدولة مرشح عبر `schedule-single` أو `auto-schedule` إلا إذا كانت حالة طلبه ضمن `['passed_assessment', 'under_review', 'interview_scheduled', 'interviewed']` (`400 APPLICATION_NOT_ELIGIBLE_FOR_INTERVIEW` لطلبات `assessment_pending` أو `failed_assessment` أو `rejected`)، مع التحقق الصارم من صيغة `YYYY-MM-DD` و `HH:MM` وأن وقت النهاية بعد البداية.
* **قفل الحالات في `PATCH /api/interviews/:id`:** يُمنع تعيين `invitation_sent` أو `confirmed` يدوياً أو إرجاع الموعد إلى `scheduled` (`400`)، ويُمنع تسجيل `completed` أو `no_show` قبل `invitation_sent` (`400`)، ويُمنع إلغاء أو إعادة جدولة مقابلة مكتملة فعلياً (`400 INTERVIEW_ALREADY_COMPLETED`).
* **التسلسل التلقائي عند الاعتذار (`status = 'rejected'`):** عند اعتماد اعتذار لمرشح لديه موعد غير مكتمل عبر `PATCH /api/applications/:id/status`، يُلغى الموعد تلقائياً (`cancelled`) ويُدوَّر `visit_token` (لإبطال رابط البطاقة فوراً `403`) وتُلغى دعوات الطابور المرتبطة به داخل نفس المعاملة الذرية.

### ج. مصفوفة صلاحيات الموظفين الحية (`Live DB Staff RBAC` — متطابقة بين الـ API والـ HTML والـ UI)
* **التحقق الحي من القاعدة (`resolveActiveStaffSession`):** كل طلب إلى `requireAuth`، `GET /api/auth/me`، صفحات `PROTECTED_PAGE_ROLES`، ومجلد `/uploads` يتحقق مباشرة من `staff_users.is_active = TRUE` والدور الحي في PostgreSQL؛ إيقاف أي حساب موظف يُسقط جلسته في اللحظة نفسها (`401` / `302`) حتى لو كان كوكي HMAC غير منتهي الصلاحية، كما يُمنع مدير النظام من إيقاف حسابه أو تخفيض صلاحياته (`400`).
* **توزيع الأدوار الثلاثة:**
  * `super_admin`: كامل الصلاحيات الإدارية وإدارة المستخدمين والأوزان وموديلات الذكاء الاصطناعي.
  * `hr_coordinator`: إدارة الوظائف، جدولة وإعادة جدولة وإلغاء المقابلات، إدارة وتشغيل طابور وقوالب واتساب، تدوير روابط استعادة المتقدمين، واعتماد حالة الطلب (`under_review` / `offered` / `rejected`)؛ ممنوع (`403`) من تقييم اللجنة (`POST /api/evaluations`) ومن صفحات المستخدمين والإعدادات العامة وتعديل أوزان الترتيب.
  * `committee_member`: استعراض المرشحين والترتيب، رصد درجات تقييم اللجنة (`POST /api/evaluations`)، رصد حضور/إتمام المقابلة (`completed` / `no_show` والملاحظات بعد إرسال الدعوة)، ومتابعة طابور المقابلات للقراءة فقط مع حجب تام لرسائل `portal_recovery`؛ ممنوع (`403`) من إنشاء أو تعديل أو فتح أو تأكيد رسائل واتساب، ومن جدولة/إعادة جدولة/إلغاء المقابلات، ومن استعادة وصول المتقدمين أو تغيير حالة التوظيف النهائية.

### د. قائمة حالات الاختبار المنفذة فعلياً ونتائجها (`npm run verify:v21` + `Chromium Headless`)

| المعرّف | المجال | وصف حالة الاختبار المنفذة | النتيجة |
| :--- | :--- | :--- | :--- |
| **TC-01** | حواجز الأمان | رفض تشغيل `verify-v21-drills.js` بدون `ALLOW_ISOLATED_DRILL=1` أو مع `NODE_ENV=production` | **PASS** |
| **TC-02** | تطابق المخطط | ترقية قاعدة `v2.0` مأهولة إلى `v2.1` ومطابقة `139/139` عموداً وحفظ قوالب JSONB المخصصة (`9/9`) | **PASS** |
| **TC-03** | ملكية المتقدم | منع الاستحواذ الجزئي (`409`) واشتراط مفتاح `JPFK-...` (`403` بدونه، `200` معه) ومنع التوكن العابر للطلبات | **PASS** |
| **TC-04** | مرفقات الاختبار | اشتراط توكن متقدم حي في القاعدة وحالة `assessment_pending` لرفع المرفقات، ورفض الرفع بعد التسليم (`403`) | **PASS** |
| **TC-05** | تزامن الاختبار | إرسال مزدوج متزامن (`Promise.all`) لـ `POST /api/assessments/submit` -> تقييم واحد `<35ms` والآخر `already_submitted: true` بلا تكرار صفوف | **PASS** |
| **TC-06** | تدوير الاستعادة | تدوير `candidate_access_token` وإبطال المفتاح القديم (`403`) وإلغاء مسودات الاستعادة السابقة تلقائياً | **PASS** |
| **TC-07** | تعارض معاملات WA | إرسال `{ action: 'confirm_sent', queue_status: 'cancelled' }` وكافة ثنائيات `action + queue_status` على الرسائل الملغاة والنشطة -> `400 CONFLICTING_WA_PARAMS` وبقاء الرسالة `cancelled` والموعد `rescheduled` | **PASS** |
| **TC-08** | قفل الرسالة الملغاة | رفض جميع الطلبات المفردة (`open_draft`, `confirm_sent`, `sent`, `queued`, `confirmed`, `failed`, `cancelled`, `message_body`) على رسالة ملغاة بـ `400 WA_MESSAGE_CANCELLED` | **PASS** |
| **TC-09** | انتقالات WA | دورة `queued -> failed -> queued -> sent`، سباق تأكيد إرسال مزدوج `[200, 400]`، منع الرجوع لـ `queued`، منع تعديل النص بعد الإرسال (`400 SENT_BODY_IMMUTABLE`)، ومنع تزوير `portal_recovery` | **PASS** |
| **TC-10** | التزامن الذري | سباق `Promise.all` بين `confirm_sent` لدعوة قديمة وإعادة الجدولة (بترتيب قفل موحّد بلا Deadlock) + سباق تدوير استعادة مزدوج -> مسودة نشطة واحدة فقط | **PASS** |
| **TC-11** | أهلية المقابلة | رفض جدولة أو تقييم أو تقديم عرض لمرشح `assessment_pending` (`400`) ورفض أوقات غير صالحة (`27:99` -> `400`) | **PASS** |
| **TC-12** | مصفوفة RBAC والإيقاف | التحقق الكامل من صلاحيات الأدوار الثلاثة (`super_admin`, `hr_coordinator`, `committee_member`) على الـ API والـ HTML، ومنع تخفيض المدير لنفسه، والإسقاط اللحظي الفوري (`401`/`302`) لكوكي موظف أُوقف حسابه | **PASS** |
| **TC-13** | متصفح فعلي (Chromium) | تسجيل دخول `hr_coordinator` في المتصفح -> فتح `Interviews.dc.html` -> النقر على صف `portal_recovery` -> التحقق من شاشة المعاينة وفتح مسودة `wa.me` بالرابط والمفتاح السليمين مع بقاء الحالة `queued` | **PASS** |
| **TC-14** | متصفح فعلي (Chromium) | النقر في المتصفح على صف `reschedule_notice` -> فتح المسودة بالرمز الجديد `vt` مع بقاء الموعد `rescheduled` -> الضغط على `✓ تأكيد الإرسال` وتحول الموعد إلى `invitation_sent` | **PASS** |
| **TC-15** | متصفح فعلي (المتقدم) | فتح متصفح مجهول لرابط الاستعادة المدوّر ثم فتح `Visit.dc.html?vt=...` والضغط على `#confirm-visit-btn` وتحول الموعد إلى `confirmed` | **PASS** |
| **TC-16** | متصفح فعلي (عضو اللجنة) | تسجيل دخول `committee_member` في المتصفح -> خلو `Interviews.dc.html` من صفوف الاستعادة وأزرار الإرسال -> `403` على `/Users.dc.html` -> رصد إتمام المقابلة ومنع إعادة جدولتها بعد الإتمام (`400`) | **PASS** |
| **TC-17** | تسلسل الاعتذار | تغيير حالة مرشح مجدول إلى `rejected` -> إلغاء الموعد تلقائياً وإبطال `vt` (`403`) وإلغاء دعوات الطابور | **PASS** |
| **DRILL-3/4** | النسخ والرجوع | `pg_dump -Fc` + استعادة بمعاملَي `-c` منفصلين + أرشيف المرفقات + رجوع `v2.1 -> 70be659` مع ملف الترقيع وإدراج `201` + تمرين `docker compose` المعزول في CI | **PASS** |

### هـ. إفصاح صريح وشفاف عمّا لم يُختبر (What Was NOT Tested)
التزاماً بالشفافية الهندسية الكاملة قبل قرار الاعتماد:
1. **التطبيق الفعلي لتطبيق واتساب الخارجي (`wa.me` -> تطبيق WhatsApp Desktop / Mobile):** تم التحقق في متصفح Chromium الحقيقي من توليد وفتح الرابط الكامل `https://wa.me/<phone>?text=...` ومطابقة الرقم والنص المشفر حرفياً، لكن لم يتم إرسال رسائل فعلية عبر خوادم شركة Meta/WhatsApp أو ربط حاوية `WAHA` بعد (مجدول للمرحلة المعتمدة `v2.3`).
2. **زمن استجابة نموذج الذكاء الاصطناعي المحلي الحي (`Ollama` على `srv1924474`):** تم التحقق من المسار غير المتزامن والعودة الاحتياطية الآمنة (`smart-rubric` `<35ms`) وعزل الـ 60 ثانية، لكن لم يتم تشغيل استدلال حي ضد حاوية Ollama الإنتاجية الفعلية على `srv1924474` احتراماً لعدم لمس بيئة الإنتاج قبل الاعتماد.
3. **التوافق البصري اليدوي على متصفحات الهواتف الفعلية (`iOS Safari` / `Android Chrome`) والطباعة الورقية الفعلية:** تم تنفيذ اختبارات المتصفح الفعلي آلياً على محرك **Playwright Headless Chromium (Linux)** وليس على أجهزة آيفون/أندرويد فيزيائية أو طابعة ورقية فعلية لبطاقة الزيارة.
4. **اختبار الضغط العالي واسع النطاق (Load / Stress Soak Testing لآلاف المستخدمين المتزامنين) وفحص Traefik الحي على `srv1924474`:** شملت اختبارات التزامن سباقات متوازية حقيقية (`Promise.all`) على الصفوف المتنازع عليها مع `PostgreSQL FOR UPDATE`، لكن لم يُنفذ اختبار حمل مستمر بمئات الطلبات في الثانية ولا تبديل فعلي خلف `traefik-traefik-1` على الخادم الإنتاجي (الذي يظل محكوماً بموافقة عبدالرحمن وتنفيذ Hermes).

