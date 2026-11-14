# متطلبات البنية التحتية لـ v2.5

> **النطاق:** المقارنة التنفيذية + العروض الوظيفية العربية PDF + أتمتة `n8n`.
> **لا تغيير على الإنتاج.** كل ما هنا يُطبَّق عند الدمج فقط، وبموافقة المالك.

---

## 1. لا توجد اعتماديات نظام جديدة

| البند | القرار | السبب |
|---|---|---|
| Chromium / Puppeteer / Playwright داخل الحاوية | ❌ **مرفوض** | +300MB صورة، +400MB ذاكرة لكل نسخة أثناء التوليد، سطح هجوم إضافي |
| مكتبات PDF سحابية مدفوعة (DocRaptor, PDFTron, Adobe) | ❌ **مرفوض** | التزام الخطة: توليد حر بلا تكلفة |
| `pdf-lib` + `@pdf-lib/fontkit` + `bidi-js` + `arabic-reshaper` | ✅ **مطلوبة** | نقية JS، بلا خدمة خارجية، بلا ثنائيات مُجمَّعة |
| خط `Amiri-Regular.ttf` (OFL) | ✅ **داخل المستودع** | 422KB، الترخيص حر، التغطية مُتحقَّق منها |

**الحجم الصافي:** لا تزيد صورة الحاوية إلا بما تُضيفه هذه الحزم النقية (~2MB في `node_modules`).
**الذاكرة:** توليد PDF واحد ≈ 25–40MB RSS مؤقتاً، ويُحرَّر بعد الإرسال.

---

## 2. متغيرات البيئة الجديدة

| المتغير | إلزامي؟ | القيمة المقترحة | الأثر عند الغياب |
|---|---|---|---|
| `N8N_WEBHOOK_ENABLED` | لا | `false` (افتراضي) | **الأتمتة معطلة تماماً.** لا شيء يُرسَل. التوظيف يعمل كاملاً |
| `N8N_OFFER_WEBHOOK_URL` | لا | `http://n8n-with-ai-assistant-f2iw:5678/webhook/jpf-hr-offers` | يُتجاهَل الحدث، يبقى في الصندوق `pending` |
| `N8N_WEBHOOK_SECRET` | لا | 32+ بايت عشوائي (**لا يُودَع في المستودع**) | يُتجاهَل الحدث، `reason: N8N_WEBHOOK_SECRET_MISSING` |
| `OUTBOX_WORKER_INTERVAL_MS` | لا | `5000` (افتراضي) | `0` = تعطيل العامل الدوري كلياً |
| `N8N_ALLOW_LOOPBACK_FOR_TESTS` | لا | **يُترك فارغاً في الإنتاج** | `1` يسمح بـ `127.0.0.1` — للاختبار المعزول فقط |

### توليد السر
```bash
openssl rand -hex 32
```
يُخزَّن في مدير أسرار المنصة فقط. لا يُكتب في `docker-compose.yml` ولا في `.env` المُودَع.

---

## 3. شبكة `n8n`

- إن كان `n8n` في نفس شبكة Docker: استخدم اسم الحاوية `n8n-with-ai-assistant-f2iw` لا `localhost`.
- **العامل يحجب `127.0.0.1`/`localhost`/`::1` افتراضياً** — مقصود لمنع التسريب الداخلي.
- إعداد حسابي:

| المتغير | القيمة |
|---|---|
| `N8N_WEBHOOK_ENABLED` | `true` |
| `N8N_OFFER_WEBHOOK_URL` | `http://n8n-with-ai-assistant-f2iw:5678/webhook/jpf-hr-offers` |
| `N8N_WEBHOOK_SECRET` | (من مدير الأسرار) |

### التحقق من التوقيع على جهة `n8n`
الجسم الخام `rawBody` + الترويسة `X-JPF-Signature: t=<ts>,v1=<hex>`:

```javascript
// n8n Function node قبل أي معالجة
const crypto = require('crypto');
const raw = $input.first().binary?.data ?? items[0].json.__rawBody;
const header = items[0].json.headers['x-jpf-signature'];
const m = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(header);
const expected = crypto.createHmac('sha256', $env.JPF_WEBHOOK_SECRET).update(`${m[1]}.${raw}`).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(expected,'hex'), Buffer.from(m[2],'hex'))) throw new Error('BAD_SIGNATURE');
if (Math.abs(Date.now()/1000 - Number(m[1])) > 300) throw new Error('STALE_TIMESTAMP'); // منع إعادة التشغيل
```

> **مهم:** يجب التحقق من **الجسم الخام** لا من `JSON.parse` المُعاد تسلسله، وإلا فشل التوقيع.

---

## 4. مجلد الرفع

- المسار: `UPLOAD_DIR` القائم (لا مجلد جديد).
- يُنشئ النظام `uploads/offers/` تلقائياً عند أول إصدار، والصلاحيات المطلوبة: كتابة للمستخدم الذي يشغّل Node.
- ملفات PDF حجمها ~220KB لكل عرض. **لا حاجة لتنظيف دوري** (سجل رسمي مطلوب للتوقيع).
- **النسخ الاحتياطي:** يجب أن يشمل `uploads/offers/` مع قاعدة البيانات **معاً** — وإلا فُقد ملف الـ PDF وبقيت بصمة `pdf_sha256` بلا مرجع.

---

## 5. الصفحات والمسارات الجديدة

| المسار | الأدوار المسموحة | المصادقة |
|---|---|---|
| `GET /api/compare?ids=` | الثلاثة | جلسة |
| `GET/PUT /api/offers/template` | `super_admin`, `hr_coordinator` | جلسة |
| `POST /api/offers` | `super_admin`, `hr_coordinator` | جلسة |
| `GET /api/offers` | الثلاثة | جلسة |
| `GET /api/offers/:id/pdf` | الثلاثة | جلسة |
| `GET /api/public/offers/:ot` | **عام** | توكن 256-بت فقط |
| `POST /api/public/offers/:ot/respond` | **عام** | توكن 256-بت فقط |
| `GET /api/automation/outbox-status` | `super_admin`, `hr_coordinator` | جلسة |

**إن كان هناك Reverse Proxy / WAF:** يجب أن يسمح بـ `/api/public/offers/*` بلا جلسة ولا CSRF، وأن **لا** يُسجّل التوكن في سجلات الوصول (`?ot=` في المسار ليس موجوداً عمداً — التوكن في المسار لا في الـ query).

---

## 6. قائمة تحقق قبل التفعيل

- [ ] `N8N_WEBHOOK_ENABLED` لا يزال `false` أو غير موجود.
- [ ] `N8N_WEBHOOK_SECRET` موضوع في مدير الأسرار (لا في Git).
- [ ] `uploads/offers/` ضمن خطة النسخ الاحتياطي.
- [ ] `WAHA_DRY_RUN=true` و `WAHA_LIVE_APPROVED=false` **بلا تغيير**.
- [ ] `bash scripts/ci-v25-steps.sh` يمرّ محلياً على الصورة الجديدة.
- [ ] `GET /api/automation/outbox-status` يعيد `delivery_enabled:false` قبل التفعيل.

---

## 7. ما **لا** تفعله هذه النسخة

- ❌ لا إرسال واتساب تلقائي (الرابط يُنسخ يدوياً، `automatic_send: false`).
- ❌ لا إرسال بريد إلكتروني.
- ❌ لا توليد PDF عبر خدمة خارجية.
- ❌ لا اتصال بـ `n8n` إن لم يُفعَّل صراحةً.
- ❌ لا تعديل على جداول v2.4 أو بياناتها.
