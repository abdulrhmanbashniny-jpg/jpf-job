# سجل المهام الحي والمتابعة الذاتية للمشروع (`ARENA_TASK_TRACKER.md`)

- **اسم الوكيل المنفّذ للتطبيق والـ APIs والاختبارات**: **Arena (`Arena.ai Agent`)**
- **اسم الوكيل المنفّذ للبنية التحتية والخادم `srv1924474`**: **Hermes**
- **المستودع الرسمي**: `https://github.com/abdulrhmanbashniny-jpg/jpf-job`
- **النطاق الحي**: `https://hrjpf.tech`
- **قناة التنسيق الرسمية بين الوكيلين**: [GitHub Issue #2 (`HERMES-ARENA-SYNC`)](https://github.com/abdulrhmanbashniny-jpg/jpf-job/issues/2)
- **تاريخ آخر تحديث**: `2026-11-12` (بتوقيت الرياض `Asia/Riyadh`) — بواسطة **Arena**

> ### 📌 قاعدة مستدامة إلزامية لأي جلسة أو محادثة جديدة لوكيل `Arena`:
> 1. اقرأ هذا الملف (`ARENA_TASK_TRACKER.md`) وملف `UNIFIED_EXECUTION_PLAN_V2.2_V2.5.md` وتعليقات `Issue #2` فور استنساخ المستودع لمعرفة آخر نقطة توقف بدقة دون تكرار أي عمل منجز.
> 2. **بعد إنجاز أي مهمة أو مرحلة**، حدّث حالتها في هذا الملف فوراً إلى **`✅ تم الإنجاز — بواسطة Arena`** مع ذكر رقم الـ `Commit SHA` ورقم الـ `PR` وحالة `CI`، وارفع التحديث إلى GitHub ضمن نفس الـ Commit حتى يبقى المستودع وحده كافياً للانتقال لأي محادثة جديدة في أي لحظة.
> 3. لا تحفظ أي مفتاح سري (`PAT` أو `.env`) داخل المستودع نهائياً (استخدم `/tmp/.gh_pat` بصلاحية `0600` واحذفه عند الانتهاء).
> 4. لا تدمج أي فرع في `main` إلا بعد صدور `HERMES_VERDICT: APPROVED sha=<full_sha>` في `Issue #2`.

---

## ملخص التقدم العام (نظرة سريعة)

| المرحلة | المسؤول عن الكود | الفرع / PR على GitHub | حالة التنفيذ |
|---|---|---|---|
| **الأساس الإنتاجي (`v2.1`)** | Arena + Hermes | `main` (`d0eb509`) — PR #1 | ✅ **تم الإنجاز والاعتماد والنشر حياً على `hrjpf.tech`** |
| **الخطة التنفيذية الموحدة (`v2.2a`–`v2.5`)** | Arena | `UNIFIED_EXECUTION_PLAN_V2.2_V2.5.md` + Issue #2 | ✅ **تم الإنجاز — بواسطة Arena** |
| **المرحلة 1 (`v2.2a`)**: استقبال المرشحين بالـ QR وتنبيه اللجنة | Arena | `main` @ `4fc4392` (دمج **PR #3**) — HEAD الفرع `4c4912b` | ✅ **تم الإنجاز — بواسطة Arena** (CI أخضر 4/4 + `HERMES_VERDICT: APPROVED sha=4c4912b37091133f6e0ac3d398da2de6a2a09ad3` + مدمج في `main`) |
| **المرحلة 2 (`v2.2b`)**: السؤال الصوتي الاختياري 60 ثانية وحذف 30 يوماً | Arena | `main` @ `1c9033a` (دمج **PR #4**) — HEAD الفرع `e1b82dd` | ✅ **تم الإنجاز — بواسطة Arena** (CI أخضر 6/6 + `HERMES_VERDICT: APPROVED sha=e1b82dd504bf53a0d046f927a64c634f8a5632b2` + مدمج في `main`) |
| **المرحلة 3 (`v2.3`)**: رسائل واتساب التشغيلية عبر `WAHA` (`Dry-Run` إلزامي) | Arena | `origin/wip/v2.3-starter` (`bf6f878`) -> `release/v2.3` (PR #5) | ⏳ **قيد التنفيذ (أُنجز 40% منها — نقطة الاستئناف المباشرة)** |
| **المرحلة 4 (`v2.4`)**: قاعات الفيديو `Jitsi` والتقييم المقسّم | Arena | `release/v2.4` (PR #6) | 🔜 **في الانتظار (تبدأ فور انتهاء `v2.3`)** |
| **المرحلة 5 (`v2.5`)**: المقارنة التنفيذية + العرض الوظيفي PDF + `n8n` | Arena | `release/v2.5` (PR #7) | 🔜 **في الانتظار (تبدأ فور انتهاء `v2.4`)** |

---

## سجل المهام التفصيلي (Task-by-Task Checklist)

### المرحلة 0: التأسيس والحوكمة المشتركة
- [x] **إعداد الخطة التنفيذية الموحدة (`UNIFIED_EXECUTION_PLAN_V2.2_V2.5.md`) واعتماد قرارات المالك الأربعة** — ✅ **تم الإنجاز — بواسطة Arena**
- [x] **قراءة جرد الخادم الحي من Hermes في `Issue #2` ونشر خطة `[ARCHITECT]` الرسمية (`issuecomment-6781885282`)** — ✅ **تم الإنجاز — بواسطة Arena**

---

### المرحلة 1 (`v2.2a`): نظام الاستقبال الذكي بالـ QR وتنبيه اللجنة اللحظي
- [x] **ترقية مخطط `interviews` التراكمي (`lobby_status`, `checked_in_at`, `checked_in_by`, `punctuality_minutes`) بتطابق `143/143` عموداً (0 فرق)** — ✅ **تم الإنجاز — بواسطة Arena**
- [x] **توليد رموز QR الموقعة بـ HMAC-SHA256 (`JPFQR:...`) وربطها بـ `visit_token` الحي مع الإبطال التلقائي عند الإلغاء أو إعادة الجدولة** — ✅ **تم الإنجاز — بواسطة Arena**
- [x] **دمج مكتبة `jsQR.js` محلياً بدون أي CDN خارجي وبناء شاشة `public/Reception.dc.html` محصورة بدورَي `hr_coordinator` و `super_admin` (سقف 3 أدوار)** — ✅ **تم الإنجاز — بواسطة Arena**
- [x] **بناء مسارات `/api/reception/verify-qr` و `/api/reception/check-in` (`FOR UPDATE` ذري) و `/api/reception/arrivals` وشريط التنبيه الحي للجنة في `common.js` و `CandidateProfile.dc.html`** — ✅ **تم الإنجاز — بواسطة Arena**
- [x] **بناء واجتياز حزمة اختبارات `scripts/verify-v22a.js` (الأمان + التزامن الخماسي + Playwright Chromium E2E) ورفع `origin/release/v2.2a` وفتح `PR #3` واخضرار CI `4/4` وإشعار Hermes في `Issue #2`** — ✅ **تم الإنجاز — بواسطة Arena**
- [x] **معالجة ملاحظات مراجعة Hermes الثلاث على `PR #3` بالكامل**: (1) منع تكرار تنبيه اللجنة كل 15 ثانية + مسار `POST /api/reception/arrivals/:id/acknowledge`، (2) محفز قاعدة بيانات `trg_sync_interview_lobby_status` + تحديث `server.js` لضمان تحول `lobby_status` إلى `completed` فور اكتمال المقابلة وعدم بقائه `checked_in`، و(3) توسيع CI (`verify:v22a` + `ci-container-rollback-drill.sh`) لاختبار حماية المرفقات/PII والرجوع الفعلي إلى `v2.1` (`d0eb509`) فوق قاعدة بيانات مُرقّاة — ✅ **تم الإنجاز — بواسطة Arena**
- [x] **إعادة مراجعة واعتماد `PR #3` (`HERMES_VERDICT: APPROVED sha=4c4912b37091133f6e0ac3d398da2de6a2a09ad3` على Issue #2 `issuecomment-6875277992`) والدمج في `main` @ `4fc4392ee4dfb66bc8b8386af01179210337766b`** — ✅ **تم الإنجاز — بواسطة Arena** (النشر على `srv1924474` بيد Hermes بعد `READY_FOR_DEPLOY`)

---

### المرحلة 2 (`v2.2b`): السؤال الصوتي الاختياري (60 ثانية) والحوكمة والحذف التلقائي بعد 30 يوماً
- [x] **ترقية جدول `applications` بـ 12 عموداً صوتياً وحوكمياً بتطابق `155/155` عموداً (0 فرق)** — ✅ **تم الإنجاز — بواسطة Arena**
- [x] **فحص البصمة الثنائية لملفات الصوت (`detectSafeAudioContainer`: WebM/OGG/M4A/WAV/MP3 بحد `2.5MB`) والتخزين المعزول في `uploads/voice_pitches` مع حجب الوصول المباشر `403`** — ✅ **تم الإنجاز — بواسطة Arena**
- [x] **بناء واجهة البث المسجّلة في `audit_logs` بدعم `HTTP 206 Range` (`/api/applications/:idOrRef/voice-stream`) وتقييم اللجنة البشري (`0..5` مكافأة تميز بدون رفض آلي)** — ✅ **تم الإنجاز — بواسطة Arena**
- [x] **بناء المجدول التلقائي ومسار `/api/system/purge-expired-voice` لحذف مقاطع غير المختارين بعد 30 يوماً مع استثناء المقبولين (`status = 'offered'`)** — ✅ **تم الإنجاز — بواسطة Arena**
- [x] **إضافة أداة التسجيل الاختيارية في `Assessment.dc.html` و `ResultPass.dc.html` وبطاقة المراجعة البشرية في `CandidateProfile.dc.html` وشارة `Ranking.dc.html`** — ✅ **تم الإنجاز — بواسطة Arena**
- [x] **بناء واجتياز حزمة `scripts/verify-v22b.js` ورفع `origin/release/v2.2b` وفتح `PR #4` واخضرار CI `4/4` وإشعار Hermes في `Issue #2`** — ✅ **تم الإنجاز — بواسطة Arena**
- [x] **معالجة ملاحظات مراجعة Hermes الأربع على `PR #4` بالكامل**: (1) فحص علم الميزة `requireVoicePitchEnabled` (`503 VOICE_PITCH_DISABLED`) قبل استهلاك الذاكرة أو القرص، (2) حظر الاستماع للتسجيلات منتهية الصلاحية في `/voice-stream` (`410 VOICE_RETENTION_EXPIRED` + تطهير فوري)، (3) حذف الملف من القرص أولاً قبل تفريغ القاعدة (`unlinkVoiceFileStrict`) + كنس الملفات اليتيمة (`VOICE_ORPHAN_FILES_SWEPT`)، و(4) محدد معدل مخصص `voiceUploadLimiter` + سقف رفع لكل طلب (`429`) — ✅ **تم الإنجاز — بواسطة Arena**
- [x] **إعادة مراجعة واعتماد `PR #4` (`HERMES_VERDICT: APPROVED sha=e1b82dd504bf53a0d046f927a64c634f8a5632b2` على Issue #2 `issuecomment-6875277992`) والدمج في `main` @ `1c9033aa8683df765e7491c4bd7efeb46e70c257`** — ✅ **تم الإنجاز — بواسطة Arena** (النشر على `srv1924474` بيد Hermes بعد `READY_FOR_DEPLOY`)

---

### المرحلة 3 (`v2.3`): رسائل واتساب التشغيلية عبر `WAHA` (وضع `WAHA_DRY_RUN=true` الإلزامي)
- [x] **ترقية جدول `wa_messages` (`delivery_channel`, `idempotency_key` الفريد, `external_message_id`, `attempt_count`, `last_attempt_at`, `last_error`, `dry_run_payload`) وإعداد `waha_config` الافتراضي الآمن** — ✅ **تم الإنجاز — بواسطة Arena** (محفوظ على GitHub في فرع `origin/wip/v2.3-starter` @ `bf6f878c13a0562799d370fccf0ec7883b22b980`)
- [x] **بناء خدمة `services/wahaClient.js` بقفل `WAHA_DRY_RUN=true` المزدوج وفحص الجاهزية للقراءة فقط (`probeWahaStatus`) ومهلة 5 ثوانٍ والسقوط الآمن إلى `wa.me`** — ✅ **تم الإنجاز — بواسطة Arena** (في `origin/wip/v2.3-starter` @ `bf6f878c13a0562799d370fccf0ec7883b22b980`)
- [ ] **استكمال القسم 13 في `server.js`: مسارات `GET /api/waha/status`، `PATCH /api/waha/config`، مفتاح الإيقاف الفوري `POST /api/waha/kill-switch`، والإرسال الفردي المحكوم `POST /api/wa-messages/:id/dispatch-waha` (قفل `applications -> interviews -> wa_messages`، منع الرسائل الرجعية قبل `waha_activated_at`، منع `portal_recovery`، وحد المعدل `6/د` و `25/س`)** — ⏳ **المهمة التالية مباشرة لـ Arena**
- [ ] **تحديث واجهة `public/Interviews.dc.html` بشريط حالة `WAHA Dry-Run`، زر الإيقاف الفوري للطوارئ (`Kill-Switch`)، وزر محاكاة الإرسال الآمن لكل صف بجانب رابط `wa.me` اليدوي** — ⏳ **بانتظار Arena**
- [ ] **كتابة واجتياز `scripts/verify-v23.js` + ربطه في `.github/workflows/ci.yml` + دفع فرع `release/v2.3` وفتح `PR #5` واخضرار CI وإرسال `READY_FOR_REVIEW` على `Issue #2`** — ⏳ **بانتظار Arena**

---

### المرحلة 4 (`v2.4`): قاعات مقابلات الفيديو `Jitsi` (`meet.hrjpf.tech`) والتقييم المقسّم
- [ ] **ترقية جدول `interviews` بحقول غرفة الفيديو الموقعة (`jitsi_room_name`, `jitsi_moderator_hint`, `video_provider_status`) بتطابق تام للأعمدة** — 🔜 **بانتظار Arena**
- [ ] **بناء خدمة توليد غرف `Jitsi` العشوائية غير القابلة للتخمين مع فحص الجاهزية المرن لـ `JITSI_DOMAIN` (`meet.hrjpf.tech`) والسقوط الآمن عند عدم توفر DNS دون كسر `hrjpf.tech`** — 🔜 **بانتظار Arena**
- [ ] **بناء صفحة `public/InterviewRoom.dc.html` بالتصميم المقسّم (Split-Screen: نافذة الفيديو يميناً + بطاقة التقييم الفوري للجنة يساراً) وتحديث `Visit.dc.html` و `Scheduler.dc.html`** — 🔜 **بانتظار Arena**
- [ ] **كتابة واجتياز `scripts/verify-v24.js` + فتح `PR #6` (`release/v2.4`) واخضرار CI وإرسال `READY_FOR_REVIEW` على `Issue #2`** — 🔜 **بانتظار Arena**

---

### المرحلة 5 (`v2.5`): المقارنة التنفيذية + العروض الوظيفية العربية PDF (بقالب قابل للتخصيص) + `n8n`
- [ ] **إنشاء جداول `job_offers` و `automation_outbox` (لتكامل `n8n` غير الحاجب) وإعداد قالب العرض الوظيفي القابل للتخصيص في `system_settings` بتطابق تام للأعمدة** — 🔜 **بانتظار Arena**
- [ ] **بناء لوحة المقارنة التنفيذية جنباً إلى جنب (`public/Compare.dc.html` لـ 2–4 مرشحين) مع مقارنة الدرجات والسيرة والتعريف الصوتي وملاحظات اللجنة** — 🔜 **بانتظار Arena**
- [ ] **بناء استوديو إصدار وتخصيص العروض الوظيفية العربية RTL (`public/OfferLetter.dc.html` لمسؤولي `hr_coordinator` و `super_admin`) وصفحة قبول/توقيع المرشح الموقعة (`public/OfferView.dc.html`) وتصدير PDF عربي نظيف بدون مكتبات سحابية مدفوعة** — 🔜 **بانتظار Arena**
- [ ] **بناء عامل تسليم أحداث `n8n` الموقعة بـ HMAC من `automation_outbox` (لا يُفشل أي عملية توظيف إذا كان `n8n` غير متصل)** — 🔜 **بانتظار Arena**
- [ ] **كتابة واجتياز `scripts/verify-v25.js` + فتح `PR #7` (`release/v2.5`) واخضرار CI وإرسال `READY_FOR_REVIEW` والتقرير النهائي الشامل للمالك ولـ Hermes** — 🔜 **بانتظار Arena**
