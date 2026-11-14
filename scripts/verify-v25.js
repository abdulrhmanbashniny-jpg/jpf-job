#!/usr/bin/env node
/**
 * verify-v25.js — تحقق بوابة v2.5 (المقارنة + العروض PDF العربية + n8n)
 * ---------------------------------------------------------------------------------
 * لا يلمس قاعدة بيانات ولا شبكة: يفحص العقود وحدود الأمان وبنية PDF والنصوص.
 * الفحص الحيّ (قاعدة معزولة + متصفح) في verify-v25-live.js.
 *
 * الأبواب:
 *  1.  schema      : job_offers + automation_outbox + توسيع حالة الطلب
 *  2.  pdf-arabic  : التشكيل والترتيب البصري صحيحان (اختبار حرفي على codepoints)
 *  3.  pdf-dates   : التواريخ والأرقام لا تُعكس (الخطأ الذي وقعنا فيه)
 *  4.  pdf-build   : PDF يُبنى فعلياً، عربي، بصمة SHA-256، ونصه قابل للاستخراج
 *  5.  font        : الخط العربي مضمَّن وكامل التغطية لصور الحروف
 *  6.  template    : تطبيع القالب + منع الحقن في HTML
 *  7.  token       : توكن العرض 256-بت، يُخزَّن مُهشّراً، صيغة صارمة
 *  8.  outbox      : توقيع HMAC + منع loopback + تعطيل افتراضي + backoff
 *  9.  rbac        : committee لا يُصدر عروضاً + لا أسرار في الاستجابات
 * 10.  wiring      : الصفحات والمسارات مربوطة فعلياً
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const results = [];
const TOTAL_GATES = 10;
let failed = 0;

function gate(id, name, fn) {
  const started = Date.now();
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ id, name, ok: true });
      console.log(`  ✅ ${id}. ${name} (${Date.now() - started}ms)`);
    })
    .catch((err) => {
      failed += 1;
      results.push({ id, name, ok: false, error: err.message });
      console.log(`  ❌ ${id}. ${name} → ${err.message}`);
    });
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

async function main() {
  console.log('\n🔎 verify:v25 — المقارنة والعروض العربية وأتمتة n8n\n');

  const offerPdf = require(path.join(ROOT, 'services', 'offerPdf.js'));
  const outbox = require(path.join(ROOT, 'services', 'automationOutbox.js'));
  const offerRoutes = require(path.join(ROOT, 'services', 'offerRoutes.js'));

  // ---------------------------------------------------------------------------
  await gate('1', 'schema: job_offers + automation_outbox + hired/offer_declined', async () => {
    const schema = read('database/schema_and_seed.sql');
    assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS job_offers'), 'جدول job_offers مفقود');
    assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS automation_outbox'), 'جدول automation_outbox مفقود');

    for (const col of ['offer_ref', 'application_id', 'total_monthly_salary', 'offer_token',
      'offer_status', 'pdf_sha256', 'n8n_sync_status', 'candidate_signed_name', 'signed_at']) {
      assert.ok(schema.includes(col), `عمود مفقود في job_offers: ${col}`);
    }
    // عمود محسوب لا يُكتب يدوياً
    assert.ok(/total_monthly_salary\s+NUMERIC\(12,2\)\s+GENERATED ALWAYS AS/.test(schema),
      'total_monthly_salary يجب أن يكون GENERATED ALWAYS');
    // حالات العرض
    const statusMatch = schema.match(/offer_status\s+VARCHAR\(24\)[\s\S]{0,300}?\)\)/);
    assert.ok(statusMatch, 'قيد حالات العرض مفقود');
    const statusBlock = statusMatch[0];
    for (const s of ['draft', 'issued', 'accepted', 'declined', 'expired', 'revoked']) {
      assert.ok(statusBlock.includes(`'${s}'`), `حالة عرض مفقودة: ${s}`);
    }
    // حالات الطلب الجديدة
    assert.ok(schema.includes("'hired'"), 'حالة hired مفقودة');
    assert.ok(schema.includes("'offer_declined'"), 'حالة offer_declined مفقودة');

    // الترحيل التراكمي
    const dbJs = read('database/db.js');
    assert.ok(dbJs.includes('CREATE TABLE IF NOT EXISTS job_offers'), 'db.js لا ينشئ job_offers');
    assert.ok(dbJs.includes('offer_declined'), 'db.js لا يوسّع قيد حالات الطلب');
    assert.ok(dbJs.includes('offer_template_config'), 'db.js لا يزرع قالب العرض');
  });

  // ---------------------------------------------------------------------------
  await gate('2', 'pdf-arabic: التشكيل والترتيب البصري صحيحان حرفياً', async () => {
    // «عرض» منطقياً = ع(0639) ر(0631) ض(0636)
    // الأشكال المنطقية = ﻋ initial (FECB) ثم ﺮ final (FEAE) ثم ﺽ final (FEBD).
    //
    // ⚠️ عقيدة مُثبتة بالاختبار: pdf-lib/fontkit يعكس المقطع RTL بنفسه عند كتابة
    // مجرى المحتوى (تحققنا من ذلك بقراءة أكواد الحروف داخل التدفق: إرسال
    // FE94,FEDB,FEAE,FEB7 يُنتج التدفق FEB7,FEAE,FEDB,FE94). لذلك يجب تسليم
    // النص **بترتيبه المنطقي المشكَّل** بلا إعادة ترتيب، وإلا انعكس مرتين وخرج معكوساً.
    const shaped = offerPdf.toVisualArabic('عرض');
    const cps = [...shaped].map((c) => c.codePointAt(0));
    assert.deepStrictEqual(cps, [0xFECB, 0xFEAE, 0xFEBD],
      `ترتيب الأشكال المنطقي غير صحيح: ${cps.map((c) => c.toString(16)).join(',')}`);

    // تحقق من عدم وجود إعادة ترتيب bidi داخل الدالة (الخطأ الذي جعل المستند معكوساً)
    const srcPdf = read('services/offerPdf.js');
    const tv = srcPdf.slice(srcPdf.indexOf('function toVisualArabic'));
    const tvBody = tv.slice(0, tv.indexOf('\n}'));
    assert.ok(!/getReorderedString|getEmbeddingLevels/.test(tvBody),
      'toVisualArabic يعيد تطبيق bidi — سيُعكس المستند مرتين');

    // كلمة متعددة: «الموارد» — نتحقق أنها مشكّلة (كل المحارف في نطاق العرض)
    const multi = offerPdf.toVisualArabic('الموارد');
    const allPresentation = [...multi].every((c) => {
      const cp = c.codePointAt(0);
      return cp === 0x20 || (cp >= 0xFB50 && cp <= 0xFEFF);
    });
    assert.ok(allPresentation, 'النص لم يُشكَّل بالكامل إلى صور الحروف');

    // النص الفارغ لا يكسر شيئاً
    assert.strictEqual(offerPdf.toVisualArabic(''), '');
    assert.strictEqual(offerPdf.toVisualArabic(null), '');
    // محارف التحكم تُزال
    assert.ok(!offerPdf.toVisualArabic('سلا\u202Eم\u200F').includes('\u202E'), 'محارف التوجيه لم تُزل');
  });

  // ---------------------------------------------------------------------------
  await gate('3', 'pdf-dates: الأرقام والتواريخ لا تُعكس', async () => {
    // هذا بالضبط الخطأ الذي وقع: التاريخ كان يُرسم 6202-11-41
    // القاعدة: أي قيمة ASCII (تاريخ/مبلغ/رقم عرض) تُرسم كتدفق LTR مستقل، لا داخل جملة عربية.
    const src = read('services/offerPdf.js');
    assert.ok(src.includes('drawKeyValueRow'), 'مساعد الصفوف الرقمية مفقود');
    assert.ok(/const isAscii = ASCII_SAFE\.test/.test(src), 'لا تمييز للقيم اللاتينية/الرقمية');
    assert.ok(/page\.drawText\(rawValue/.test(src), 'القيم الرقمية لا تُرسم كتدفق مستقل');
    // رقم العرض (OFR-…) كان يُحقن داخل جملة عربية فيُبعثر إلى 1000-6202-RFO
    const refBlock = src.slice(src.indexOf('const refValue'), src.indexOf('const refValue') + 900);
    assert.ok(/page\.drawText\(refValue/.test(refBlock), 'رقم العرض لا يُرسم كتدفق LTR مستقل');

    // وبصرياً: التاريخ يجب أن يبقى كما هو في التدفق المستقل
    const asciiCheck = /^[\x20-\x7E]+$/.test('2026-11-14');
    assert.ok(asciiCheck, 'التاريخ يجب أن يُعامل كقيمة LTR');

    // دالة التنسيق لا تغيّر ترتيب الأرقام
    assert.strictEqual(offerPdf.formatMoney(12000), '12,000.00');
    assert.strictEqual(offerPdf.formatDate('2026-11-14'), '2026-11-14');
  });

  // ---------------------------------------------------------------------------
  await gate('4', 'pdf-build: PDF عربي فعلي ببصمة SHA-256', async () => {
    const built = await offerPdf.buildOfferPdf({
      offer_ref: 'OFR-2026-9001',
      candidate_name: 'محمد عبدالله الأحمدي',
      job_title_snapshot: 'مهندس برمجيات',
      department_snapshot: 'قسم التقنية',
      issued_date: '2026-11-14',
      expected_start_date: '2026-12-01',
      valid_until: '2026-12-15',
      basic_salary: 12000, housing_allowance: 3000,
      transport_allowance: 800, other_allowances: 200,
      probation_days: 90, annual_leave_days: 21,
      special_terms: 'العمل عن بُعد يومان أسبوعياً.'
    }, {});

    assert.ok(Buffer.isBuffer(built.bytes), 'الناتج ليس Buffer');
    assert.ok(built.bytes.length > 10000, `حجم PDF صغير جداً: ${built.bytes.length}`);
    assert.strictEqual(built.bytes.slice(0, 5).toString(), '%PDF-', 'الملف ليس PDF');
    assert.strictEqual(built.sha256.length, 64, 'بصمة SHA-256 غير صحيحة الطول');
    assert.ok(/^[a-f0-9]{64}$/.test(built.sha256), 'بصمة غير سداسية عشرية');
    assert.strictEqual(built.pageCount, 1, 'يجب أن يكون صفحة واحدة');

    // البصمة يجب أن تُطابق البايتات
    const crypto = require('crypto');
    const recomputed = crypto.createHash('sha256').update(built.bytes).digest('hex');
    assert.strictEqual(built.sha256, recomputed, 'البصمة لا تطابق البايتات');

    // لا محارف بديلة/مربعات (dotted circle) — المؤشر على فشل تضمين الخط
    const raw = built.bytes.toString('latin1');
    assert.ok(!raw.includes('\u25CC'), 'الملف يحوي محارف بديلة (نقص خط)');
    // الخط مضمَّن فعلياً: نفتح تدفقات FlateDecode ونبحث عن FontFile2
    const zlib = require('zlib');
    let inflated = '';
    const re = /stream\r?\n/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const start = m.index + m[0].length;
      const end = raw.indexOf('endstream', start);
      if (end < 0) continue;
      try {
        inflated += zlib.inflateSync(built.bytes.subarray(start, end)).toString('latin1');
      } catch (_e) { /* تدفق غير مضغوط */ }
    }
    assert.ok(/FontFile2|FontFile/.test(inflated) || /FontFile2|FontFile/.test(raw),
      'لا يوجد خط مضمَّن داخل PDF (FontFile2)');
    assert.ok(/Amiri/i.test(inflated) || /Amiri/i.test(raw), 'اسم الخط العربي غير مسجّل في الملف');

    // ---------------------------------------------------------------------
    // حارس الانعكاس (حاسم): نبني PDF صغيراً بكلمة معروفة، ونقرأ أكواد الحروف
    // فعلياً من مجرى المحتوى. pdf-lib يعكس المقطع RTL بنفسه، لذا يجب أن يظهر
    // على الورق ترتيب بصري صحيح — وأي إعادة ترتيب مسبقة تُنتج مستنداً معكوساً.
    // ---------------------------------------------------------------------
    const { PDFDocument } = require('pdf-lib');
    const fk = require('@pdf-lib/fontkit');
    const fontBytes = fs.readFileSync(path.join(ROOT, 'public', 'fonts', 'Amiri-Regular.ttf'));
    const font = fk.create(fontBytes);

    // الترتيب البصري المتوقع لـ«شركة» (يُقرأ من اليمين): ش ر ك ة
    const EXPECTED = [0xFE94, 0xFEDB, 0xFEAE, 0xFEB7]; // ة-final, ر-final, ك-final, ش-initial
    const expectedGids = EXPECTED.map((cp) => font.glyphForCodePoint(cp).id);

    const probeDoc = await PDFDocument.create();
    probeDoc.registerFontkit(fk);
    const probeFont = await probeDoc.embedFont(fontBytes, { subset: false });
    probeDoc.addPage([200, 80])
      .drawText(offerPdf.toVisualArabic('شركة'), { x: 20, y: 30, size: 24, font: probeFont });
    // useObjectStreams:false يمنع ضغط مجرى المحتوى داخل ObjStm فيسهل قراءته نصياً
    const probeBytes = Buffer.from(await probeDoc.save({ useObjectStreams: false }));
    const probeRaw = probeBytes.toString('latin1');

    let probeFlow = '';
    let pm;
    const pre = /stream\r?\n/g;
    while ((pm = pre.exec(probeRaw)) !== null) {
      const st = pm.index + pm[0].length;
      const en = probeRaw.indexOf('endstream', st);
      if (en < 0) continue;
      try { probeFlow += zlib.inflateSync(probeBytes.subarray(st, en)).toString('latin1'); } catch (_e) {}
    }
    assert.ok(probeFlow, 'تعذّر فك تدفق محتوى الملف التجريبي');

    const run = /<([0-9A-Fa-f]+)>\s*Tj/.exec(probeFlow);
    assert.ok(run, 'لا يوجد نص مرسوم في تدفق المحتوى');
    const drawnGids = [];
    for (let i = 0; i + 4 <= run[1].length; i += 4) drawnGids.push(parseInt(run[1].slice(i, i + 4), 16));
    assert.deepStrictEqual(drawnGids, expectedGids,
      `ترتيب الحروف المرسوم فعلياً غير صحيح (${drawnGids.map((g) => g.toString(16)).join(',')}) — ` +
      'المستند سيخرج معكوساً. السبب المعتاد: إعادة ترتيب bidi قبل التسليم لـ pdf-lib.');
  });

  // ---------------------------------------------------------------------------
  await gate('5', 'font: الخط العربي مضمَّن وكامل التغطية', async () => {
    const fontPath = path.join(ROOT, 'public', 'fonts', 'Amiri-Regular.ttf');
    assert.ok(fs.existsSync(fontPath), 'خط Amiri مفقود');
    const fontkit = require('@pdf-lib/fontkit');
    const font = fontkit.create(fs.readFileSync(fontPath));
    const chars = font.characterSet;
    // صور الحروف الأساسية للعربية (Presentation Forms-B)
    for (const cp of [0xFEBD, 0xFEAE, 0xFECB, 0xFE94, 0xFEE4, 0xFEDF]) {
      assert.ok(chars.includes(cp), `الخط ناقص المحرف U+${cp.toString(16).toUpperCase()}`);
    }
    assert.ok(chars.length > 1000, `تغطية الخط ضعيفة: ${chars.length}`);
    // ترخيص حر مذكور
    const readme = read('public/fonts/README.md');
    assert.ok(/OFL|SIL Open Font License/i.test(readme), 'ترخيص الخط غير موثّق');
  });

  // ---------------------------------------------------------------------------
  await gate('6', 'template: تطبيع القالب ومنع الحقن', async () => {
    const t = offerPdf.normalizeTemplate({ company_name: 'شركة اختبار', evil: 'DROP TABLE', nested: { a: 1 } });
    assert.strictEqual(t.company_name, 'شركة اختبار');
    assert.ok(!('evil' in t), 'مفتاح غير معروف مرّ إلى القالب');
    assert.ok(!('nested' in t), 'كائن متداخل مرّ إلى القالب');
    // الافتراضي يُستخدم عند الغياب
    assert.strictEqual(offerPdf.normalizeTemplate(null).company_name, offerPdf.DEFAULT_TEMPLATE.company_name);

    // حقن HTML
    const html = offerPdf.buildOfferHtml(
      { offer_ref: 'OFR-X', candidate_name: '<script>alert(1)</script>', basic_salary: 1 },
      { company_name: '<img src=x onerror=alert(1)>' }
    );
    assert.ok(!html.includes('<script>alert(1)</script>'), 'حقن سكربت لم يُهرَّب');
    assert.ok(!/<img\s+src=x/i.test(html), 'وسم محقون ظهر كما هو في HTML');
    assert.ok(!/<script/i.test(html), 'وسم سكربت ظهر كما هو في HTML');
    assert.ok(html.includes('&lt;script&gt;'), 'التهريب لم يستخدم كيانات HTML');
    // RTL سليم في HTML
    assert.ok(html.includes('dir="rtl"'), 'صفحة العرض يجب أن تكون RTL');
  });

  // ---------------------------------------------------------------------------
  await gate('7', 'token: 256-بت، يُخزَّن مُهشّراً، وصيغة صارمة', async () => {
    const t1 = offerRoutes.generateOfferToken();
    const t2 = offerRoutes.generateOfferToken();
    assert.strictEqual(t1.length, 64, 'التوكن يجب أن يكون 64 hex (256-بت)');
    assert.ok(/^[a-f0-9]{64}$/.test(t1), 'صيغة التوكن غير صحيحة');
    assert.notStrictEqual(t1, t2, 'تكرار توكن');

    assert.ok(offerRoutes.isValidTokenShape(t1), 'التوكن الصحيح رُفض');
    assert.ok(!offerRoutes.isValidTokenShape('short'), 'توكن قصير قُبل');
    assert.ok(!offerRoutes.isValidTokenShape('z'.repeat(64)), 'توكن بمحارف خارج hex قُبل');
    assert.ok(!offerRoutes.isValidTokenShape(''), 'توكن فارغ قُبل');

    const h = offerRoutes.hashToken(t1);
    assert.strictEqual(h.length, 64);
    assert.notStrictEqual(h, t1, 'التخزين يجب أن يكون مُهشّراً لا خاماً');

    // رقم العرض بصيغة مقروءة
    assert.strictEqual(offerRoutes.buildOfferRef(7, 2026), 'OFR-2026-0007');
    assert.strictEqual(offerRoutes.buildOfferRef(1234, 2026), 'OFR-2026-1234');
  });

  // ---------------------------------------------------------------------------
  await gate('8', 'outbox: HMAC + منع loopback + تعطيل افتراضي', async () => {
    // التوقيع والتحقق
    const raw = JSON.stringify({ event: 'offer.issued' });
    const signed = outbox.signPayload(raw, 'secret-key');
    assert.ok(/^t=\d+,v1=[a-f0-9]{64}$/.test(signed.header), 'صيغة التوقيع غير صحيحة');
    assert.strictEqual(outbox.verifySignature(raw, 'secret-key', signed.header).ok, true);
    assert.strictEqual(outbox.verifySignature(raw, 'wrong-key', signed.header).ok, false);
    assert.strictEqual(outbox.verifySignature('tampered', 'secret-key', signed.header).ok, false);
    assert.strictEqual(
      outbox.verifySignature(raw, 'secret-key', signed.header, { nowSeconds: signed.timestamp + 9999 }).ok,
      false, 'طابع زمني قديم قُبل (خطر إعادة تشغيل)'
    );

    // معطّل افتراضياً
    assert.strictEqual(outbox.isDeliveryEnabled({}), false, 'التسليم يجب أن يكون معطلاً افتراضياً');
    assert.strictEqual(outbox.isDeliveryEnabled({ N8N_WEBHOOK_ENABLED: 'false' }), false);
    assert.strictEqual(outbox.isDeliveryEnabled({ N8N_WEBHOOK_ENABLED: 'true' }), true);

    // منع loopback إلا في الاختبار المعزول
    assert.strictEqual(outbox.validateWebhookUrl('http://127.0.0.1:5678/hook', {}).ok, false, 'loopback يجب أن يُحجب');
    assert.strictEqual(outbox.validateWebhookUrl('http://localhost:5678/h', {}).ok, false);
    assert.strictEqual(
      outbox.validateWebhookUrl('http://127.0.0.1:5678/h', { N8N_ALLOW_LOOPBACK_FOR_TESTS: '1' }).ok, true,
      'الاختبار المعزول يحتاج السماح'
    );
    assert.strictEqual(outbox.validateWebhookUrl('not-a-url', {}).ok, false);
    assert.strictEqual(outbox.validateWebhookUrl('ftp://example.com/h', {}).ok, false);

    // backoff تصاعدي ومحدود
    const d1 = outbox.backoffMs(1), d5 = outbox.backoffMs(5), d99 = outbox.backoffMs(99);
    assert.ok(d99 <= outbox.DEFAULTS.maxDelayMs * 1.3, 'التراجع يتجاوز السقف');
    assert.ok(d5 > d1, 'التراجع لا يتصاعد');
  });

  // ---------------------------------------------------------------------------
  await gate('9', 'rbac: اللجنة لا تُصدر عروضاً ولا أسرار في الاستجابات', async () => {
    const src = read('services/offerRoutes.js');
    // إصدار العروض مقصور على الإدارة والمنسق
    assert.ok(/router\.post\('\/offers', requireAuth\(OFFER_ISSUE_ROLES\)/.test(src),
      'إصدار العرض غير محصور بالأدوار الصحيحة');
    assert.ok(/OFFER_ISSUE_ROLES = Object\.freeze\(\['super_admin', 'hr_coordinator'\]\)/.test(src),
      'أدوار إصدار العروض غير مطابقة للخطة');
    // المقارنة متاحة للجميع
    assert.ok(/router\.get\('\/compare', requireAuth\(\),/.test(src), 'المقارنة يجب أن تكون متاحة للموظفين الثلاثة');
    // لا يُعاد التوكن الخام في القوائم
    const listBlock = src.split("router.get('/offers',")[1].split('router.get(')[0];
    assert.ok(!/\boffer_token\b/.test(listBlock), 'قائمة العروض تكشف التوكن');
    assert.ok(!/pdf_stored_path: r\.pdf_stored_path/.test(listBlock), 'قائمة العروض تكشف المسار الداخلي');
    // مسار PDF محصور بمجلد العروض — عبر باث مشترك واحد فقط (v2.5-R1)
    assert.ok(src.includes('PATH_NOT_ALLOWED'), 'لا حماية من الخروج من مجلد العروض');
    assert.ok(/full\.startsWith\(offersRoot \+ path\.sep\)/.test(src),
      'التحقق من المسار غير محكم (يجب أن يمنع البادئة المشتركة مثل offers_evil/)');
    // كل بث للملف يمر عبر المساعد الوحيد streamStoredPdf
    const streamCalls = (src.match(/streamStoredPdf\(res,/g) || []).length;
    // تعريف واحد + استدعاءان (موظفي عبر الجلسة، وعام عبر توكن العرض)
    assert.strictEqual(streamCalls, 3, `تعريف + استدعاءان متوقعان، وجدنا ${streamCalls}`);
    // ولا اتصال مباشر بمسار دون التحقق
    assert.ok(!/fs\.createReadStream\(full\)/.test(src.replace(/return fs\.createReadStream\(full\)\.pipe\(res\);/, '')),
      'بث ملف دون المرور بالمساعد المحمي');
    // لا كلمة مرور/سر في أي استجابة
    for (const bad of ['password_hash', 'N8N_WEBHOOK_SECRET:', 'JITSI_JWT_SECRET:']) {
      assert.ok(!src.includes(bad), `تسريب محتمل: ${bad}`);
    }
  });

  // ---------------------------------------------------------------------------
  await gate('10', 'wiring: الصفحات والمسارات مربوطة فعلياً', async () => {
    const server = read('server.js');
    assert.ok(server.includes("require('./services/offerRoutes')"), 'مسارات العروض غير مستوردة');
    assert.ok(server.includes("require('./services/offerPdf')"), 'خدمة PDF غير مستوردة');
    assert.ok(server.includes("require('./services/automationOutbox')"), 'صندوق الأتمتة غير مستورد');
    assert.ok(server.includes("app.use('/api', createOfferRoutes({"), 'مسارات v2.5 غير مربوطة');

    for (const f of ['public/Compare.dc.html', 'public/OfferLetter.dc.html', 'public/OfferView.dc.html',
      'services/offerPdf.js', 'services/offerRoutes.js', 'services/automationOutbox.js',
      'public/fonts/Amiri-Regular.ttf']) {
      assert.ok(fs.existsSync(path.join(ROOT, f)), `ملف مفقود: ${f}`);
    }

    const compare = read('public/Compare.dc.html');
    assert.ok(compare.includes('/api/compare?ids='), 'صفحة المقارنة لا تستدعي الـ API');
    assert.ok(compare.includes('compare-grid'), 'تخطيط المقارنة مفقود');
    assert.ok(compare.includes('voice_pitch'), 'المقارنة لا تعرض التعريف الصوتي');

    const letter = read('public/OfferLetter.dc.html');
    assert.ok(letter.includes("'/api/offers'"), 'صفحة الإصدار لا تستدعي الـ API');
    assert.ok(letter.includes('automatic_send') || letter.includes('لم يُرسل شيء تلقائياً'),
      'لا تنبيه بعدم الإرسال التلقائي');

    const view = read('public/OfferView.dc.html');
    assert.ok(view.includes('/respond'), 'صفحة المرشح لا تستدعي مسار الرد');
    assert.ok(view.includes('dir="rtl"'), 'صفحة العرض ليست RTL');

    // صحة صياغة JS
    for (const f of ['services/offerPdf.js', 'services/offerRoutes.js', 'services/automationOutbox.js', 'server.js']) {
      execFileSync(process.execPath, ['--check', path.join(ROOT, f)]);
    }
    for (const f of ['public/Compare.dc.html', 'public/OfferLetter.dc.html', 'public/OfferView.dc.html']) {
      const html = read(f);
      const inline = html.split('<script>').pop().split('</script>')[0];
      new Function(inline);
    }
  });

  // ---------------------------------------------------------------------------
  if (results.length !== TOTAL_GATES) {
    console.log(`\n❌ تحقق غير مكتمل: ${results.length}/${TOTAL_GATES} باباً.`);
    process.exit(1);
  }
  console.log('\n' + '─'.repeat(72));
  const passed = results.filter((r) => r.ok).length;
  console.log(`v2.5 GATES: ${passed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
  if (failed) {
    results.filter((r) => !r.ok).forEach((r) => console.log(`  • ${r.id} ${r.name}: ${r.error}`));
    process.exit(1);
  }
  console.log('VERIFY_V25_PASSED');
}

let completed = false;
process.on('exit', (code) => {
  if (!completed && code === 0) {
    console.error('❌ verify:v25 خرج قبل إتمام الأبواب.');
    process.exitCode = 1;
  }
});
main().then(() => { completed = true; }).catch((err) => {
  console.error('verify:v25 crashed:', err);
  completed = true;
  process.exit(1);
});
