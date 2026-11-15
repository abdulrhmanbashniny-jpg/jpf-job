#!/usr/bin/env node
/**
 * verify-v24.js — تحقق بوابة قاعات Jitsi والتقييم المقسّم (v2.4)
 * ---------------------------------------------------------------------------------
 * يعمل على قاعدة اختبار معزولة فقط (DATABASE_URL منفصل في CI) ولا يلمس الإنتاج،
 * ولا يفتح نطاقاً خارجياً: فحص DNS محاكى بالكامل عبر stub، ولا اتصال شبكي حقيقي.
 *
 * الأبواب:
 *   1.  schema       : أعمدة v2.4 + فهرس الغرف الفريد + قيد المدة
 *   2.  roomname     : عشوائية 32-hex، صيغة صارمة، عدم قابلية التخمين بين 5k مولّد
 *   3.  url/jwt      : بناء الرابط + توقيع/تحقق HS256 + لا تسريب للتوكن في query
 *   4.  dns-probe    : RESOLVED / NOT_RESOLVED / DISABLED كلها بلا رمي أخطاء (degrade آمن)
 *   5.  session      : GET room-session يثبّت الغرفة مرة واحدة ويرجع ملف المرشح بلا أسرار
 *   6.  rbac         : coordinator لا يستطيع التقييم؛ committee/super_admin يستطيعان
 *   7.  telemetry    : staff_opened / candidate_joined idempotent + call_ended يحسب المدة
 *   8.  guard        : مقابلة حضورية تُرفض (INTREVIEW_NOT_REMOTE) للقاعة والقياس
 *   9.  visit-card   : /api/public/visit/:vt يعيد jitsi_room_url للمرشح فقط عند غرفة مثبتة
 *  10.  leak         : لا أسرار في أي استجابة (لا JITSI_JWT_SECRET ولا توكن إدارة للمرشح)
 *  11.  wiring       : الصفحات والمسارات مربوطة فعلياً في server.js وpublic/
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const results = [];
const TOTAL_GATES = 14;
let failed = 0;

function gate(id, name, fn) {
  const started = Date.now();
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ id, name, ok: true, ms: Date.now() - started });
      console.log(`  ✅ ${id}. ${name} (${Date.now() - started}ms)`);
    })
    .catch((err) => {
      failed += 1;
      results.push({ id, name, ok: false, error: err.message, ms: Date.now() - started });
      console.log(`  ❌ ${id}. ${name} → ${err.message}`);
    });
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

async function main() {
  console.log('\n🔎 verify:v24 — قاعة المقابلة والتقييم المقسّم\n');

  const jitsi = require(path.join(ROOT, 'services/jitsiClient.js'));

  // ---------------------------------------------------------------------------
  await gate('1', 'schema: أعمدة v2.4 + فهرس فريد + قيد المدة', async () => {
    const schema = read('database/schema_and_seed.sql');
    for (const col of ['jitsi_room_name', 'room_opened_by_staff_at', 'candidate_joined_room_at', 'actual_call_minutes']) {
      assert.ok(schema.includes(col), `عمود مفقود في schema: ${col}`);
    }
    assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS idx_interviews_jitsi_room_name/.test(schema), 'فهرس فريد للغرفة مفقود');

    const dbJs = read('database/db.js');
    for (const col of ['jitsi_room_name', 'room_opened_by_staff_at', 'candidate_joined_room_at', 'actual_call_minutes']) {
      assert.ok(dbJs.includes(`ADD COLUMN IF NOT EXISTS ${col}`), `ترحيل تراكمي مفقود: ${col}`);
    }
    assert.ok(dbJs.includes('chk_interviews_actual_call_minutes'), 'قيد مدة المكالمة مفقود');
  });

  // ---------------------------------------------------------------------------
  await gate('2', 'roomname: عشوائي 32-hex وصيغة صارمة وعدم تكرار', async () => {
    const seen = new Set();
    for (let i = 0; i < 5000; i += 1) {
      const name = jitsi.generateRoomName();
      assert.ok(/^jpf[a-f0-9]{28}$/.test(name), `صيغة غرفة غير متوقعة: ${name}`);
      assert.ok(!seen.has(name), 'تكرار اسم غرفة (عشوائية ضعيفة)');
      seen.add(name);
    }
    assert.strictEqual(jitsi.isValidRoomName('short'), false, 'اسم قصير يجب رفضه');
    assert.strictEqual(jitsi.isValidRoomName('../../etc/passwd'), false, 'مسار ممنوع يجب رفضه');
    assert.strictEqual(jitsi.isValidRoomName(jitsi.generateRoomName()), true);
  });

  // ---------------------------------------------------------------------------
  await gate('3', 'url/jwt: HS256 سليم ولا توكن في query', async () => {
    const secret = 'x'.repeat(48);
    const room = jitsi.generateRoomName();
    const env = { domain: 'meet.example.test', appId: 'jpf', jwtSecret: secret, hasJwtSecret: true };
    const mod = jitsi.buildRoomSession({ roomName: room, role: 'moderator', displayName: 'لجنة', env });
    const par = jitsi.buildRoomSession({ roomName: room, role: 'participant', displayName: 'مرشح', env });

    assert.strictEqual(mod.url, `https://meet.example.test/${room}`);
    assert.ok(mod.join_url.includes('#jwt='), 'توكن الإدارة يجب أن يكون في fragment لا query');
    assert.ok(!mod.join_url.split('#')[0].includes('jwt'), 'لا يجوز وضع التوكن قبل #');
    assert.ok(mod.join_url.includes('config.prejoinPageEnabled=false'), 'ضبط القاعة المسبق مفقود');

    const token = mod.join_url.split('#jwt=')[1].split('&')[0];
    const [h, p, sig] = token.split('.');
    assert.strictEqual(token.split('.').length, 3, 'JWT يجب أن يكون بثلاثة أجزاء');
    const crypto = require('crypto');
    const expected = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
    assert.strictEqual(sig, expected, 'توقيع HS256 غير مطابق');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    assert.strictEqual(payload.room, room);
    assert.strictEqual(payload.context.user.moderator, true, 'اللجنة يجب أن تكون moderator');
    assert.ok(payload.exp - payload.iat >= 3600, 'مدة التوكن قصيرة جداً لمقابلة');

    const parPayload = JSON.parse(Buffer.from(par.join_url.split('#jwt=')[1].split('&')[0].split('.')[1], 'base64url').toString('utf8'));
    assert.strictEqual(parPayload.context.user.moderator, false, 'المرشح لا يجوز أن يكون moderator');
    assert.strictEqual(par.has_moderator_token, false);

    // بدون سر: غرف مفتوحة، بلا توكن، ولا كسر للوظيفة
    const openEnv = { domain: 'meet.example.test', appId: '', jwtSecret: '', hasJwtSecret: false };
    const openMod = jitsi.buildRoomSession({ roomName: room, role: 'moderator', displayName: 'لجنة', env: openEnv });
    assert.strictEqual(openMod.join_url, openMod.url);
    assert.strictEqual(openMod.jwt_enabled, false);
  });

  // ---------------------------------------------------------------------------
  await gate('4', 'dns-probe: RESOLVED / NOT_RESOLVED / DISABLED بلا رمي أخطاء', async () => {
    const okDns = { lookup: (_d, _o, cb) => cb(null, '203.0.113.9') };
    const okProbe = await jitsi.probeJitsiDomain({ dns: okDns });
    assert.strictEqual(okProbe.ok, true);
    assert.strictEqual(okProbe.status, 'RESOLVED');

    const missingDns = { lookup: (_d, _o, cb) => cb(Object.assign(new Error('nope'), { code: 'ENOTFOUND' })) };
    const badProbe = await jitsi.probeJitsiDomain({ dns: missingDns });
    assert.strictEqual(badProbe.ok, false);
    assert.strictEqual(badProbe.status, 'NOT_RESOLVED');
    assert.strictEqual(badProbe.fallback_available, true, 'يجب توفير بديل احتياطي عند فشل النطاق');
    assert.ok(String(badProbe.action_required).length > 10, 'يجب توضيح المطلوب للبنية');

    const prev = process.env.JITSI_ENABLED;
    process.env.JITSI_ENABLED = 'false';
    const disabled = await jitsi.probeJitsiDomain({ dns: missingDns });
    assert.strictEqual(disabled.status, 'DISABLED');
    if (prev === undefined) delete process.env.JITSI_ENABLED; else process.env.JITSI_ENABLED = prev;

    // محاكي تعليق DNS: يجب أن ينتهي بمهلة ولا يعلّق المنصة
    // ملاحظة: مهلة الخدمة unref'ed كي لا تُبقي عملية الخادم حيّة؛ لذلك نُبقي الحلقة حيّة هنا صراحةً
    const hangDns = { lookup: () => { /* لا يستدعي callback أبداً */ } };
    const keepAlive = setTimeout(() => {}, 6000);
    const t0 = Date.now();
    let hangProbe;
    try {
      hangProbe = await jitsi.probeJitsiDomain({ dns: hangDns });
    } finally {
      clearTimeout(keepAlive);
    }
    assert.strictEqual(hangProbe.ok, false, 'تعليق DNS يجب أن يُرجع فشلاً لا نجاحاً');
    assert.strictEqual(hangProbe.status, 'PROBE_TIMEOUT');
    assert.ok(Date.now() - t0 < 5000, 'فحص الجاهزية يجب أن ينتهي بمهلة قصيرة');
  });

  // ---------------------------------------------------------------------------
  await gate('5', 'session: تثبيت الغرفة مرة واحدة + ملف مرشح بلا أسرار', async () => {
    const routesSrc = read('services/jitsiRoutes.js');
    assert.ok(routesSrc.includes("router.get('/interviews/:id/room-session'"), 'مسار room-session مفقود');
    assert.ok(routesSrc.includes('WHERE id = $2 AND jitsi_room_name IS NULL'), 'تثبيت الغرفة ليس ذرّياً');
    assert.ok(routesSrc.includes('UNIQUE INDEX') || read('database/db.js').includes('idx_interviews_jitsi_room_name'), 'لا حماية من تكرار الغرف');
    // لا تُقرأ أعمدة سرية إطلاقاً في مسار الجلسة
    const sessionSql = routesSrc.split("router.get('/interviews/:id/room-session'")[1].split('router.post(')[0];
    for (const forbidden of ['password_hash', 'assessment_token', 'visit_token', 'candidate_access_token']) {
      assert.ok(!new RegExp(`${forbidden}[,\s]`).test(sessionSql) || !sessionSql.includes(`a.${forbidden}`),
        `حقل سري يُقرأ في مسار الجلسة: ${forbidden}`);
    }
    // مسار التخزين الداخلي للصوت يُقرأ للحكم على الإتاحة فقط — ويُمنع إرجاعه في أي استجابة
    assert.ok(!/voice_pitch_path\s*:/.test(routesSrc), 'مسار تخزين الصوت يُعاد في استجابة الجلسة!');
    assert.ok(routesSrc.includes('voice_pitch:'), 'بيانات الإتاحة الصوتية مفقودة من الاستجابة');
    const voiceBlock = routesSrc.split('voice_pitch: {')[1].split('},')[0];
    for (const leaked of ['voice_pitch_path', 'retention_expires_at', 'voice_mime_type:']) {
      assert.ok(!voiceBlock.includes(leaked), `تسريب حقل داخلي في بيانات الصوت: ${leaked}`);
    }
    assert.ok(sessionSql.includes('can_evaluate'), 'يجب إبلاغ الواجهة بصلاحية التقييم');
    assert.ok(!routesSrc.includes('JITSI_JWT_SECRET') || !/res\.json\([^)]*JITSI_JWT_SECRET/.test(routesSrc), 'لا يجوز إرجاع السر في استجابة');
  });

  // ---------------------------------------------------------------------------
  await gate('6', 'rbac: المنسق لا يقيّم واللجنة والإدارة تقيّمان', async () => {
    const routesSrc = read('services/jitsiRoutes.js');
    assert.ok(/ROOM_STAFF_ROLES = Object\.freeze\(\['super_admin', 'committee_member'\]\)/.test(routesSrc), 'أدوار القاعة غير مطابقة للخطة');
    const serverSrc = read('server.js');
    assert.ok(serverSrc.includes("app.post('/api/evaluations', requireAuth(['super_admin', 'committee_member'])"), 'تقييم اللجنة يجب أن يبقى للإدارة واللجنة فقط');
    const roomPage = read('public/InterviewRoom.dc.html');
    assert.ok(roomPage.includes('can_evaluate') && roomPage.includes('btn-save-eval'), 'الواجهة لا تحترم صلاحية التقييم');
    assert.ok(/disabled = !canEvaluate/.test(roomPage), 'زر الحفظ يجب أن يتعطّل لمن لا يملك التقييم');

    // R1-1: لا يجوز منح moderator إلا من مسار يجلب دور الطالب فعلياً
    const moderatorGrants = (serverSrc.match(/role: 'moderator'/g) || []).length;
    assert.strictEqual(moderatorGrants, 0, `يوجد ${moderatorGrants} منح moderator ثابت في server.js — يجب أن يتبع دور الطالب`);
    assert.ok(/\['super_admin', 'committee_member'\]\.includes\(req\.user\.role\)/.test(serverSrc),
      'منح صلاحية الغرفة لا يتحقق من دور الطالب');
  });

  // ---------------------------------------------------------------------------
  await gate('6b', 'R1: قيم التوصية في الواجهة مطابقة لقيد القاعدة', async () => {
    const schema = read('database/schema_and_seed.sql');
    // نأخذ الجزء الداخلي من CHECK فقط (بعد "IN (") لتفادي التقاط DEFAULT 'hire'
    const checkBlock = schema.split('recommendation              VARCHAR(30)')[1].split('IN (')[1].split('))')[0];
    const dbValues = [...checkBlock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual(dbValues.sort(), ['hire', 'hold', 'no_hire', 'strong_hire'].sort(),
      `قيم قيد التوصية غير متوقعة: ${dbValues.join(', ')}`);

    const roomPage = read('public/InterviewRoom.dc.html');
    const optionValues = [...roomPage.matchAll(/<option value="([a-z_]*)"/g)].map((m) => m[1]).filter(Boolean);
    const unknown = optionValues.filter((v) => !dbValues.includes(v));
    assert.deepStrictEqual(unknown, [], `الواجهة ترسل قيماً ترفضها القاعدة (تُسقط التقييم بـ 500): ${unknown.join(', ')}`);

    const serverSrc = read('server.js');
    assert.ok(serverSrc.includes("INVALID_RECOMMENDATION"), 'لا تحقق مسبق من التوصية في الـ API');
    const apiValues = [...serverSrc.matchAll(/ALLOWED_RECOMMENDATIONS = \[([^\]]+)\]/g)][0];
    assert.ok(apiValues, 'قائمة التوصيات المسموحة غير معرّفة في الـ API');
    const apiList = [...apiValues[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual(apiList.sort(), dbValues.sort(), 'قائمة الـ API لا تطابق قيد القاعدة');
  });

  // ---------------------------------------------------------------------------
  await gate('6c', 'R1: التقييم المحفوظ يُحمَّل ولا يُستبدل بقيم افتراضية', async () => {
    const routesSrc = read('services/jitsiRoutes.js');
    assert.ok(routesSrc.includes('my_evaluation'), 'جلسة القاعة لا تعيد تقييم العضو المحفوظ');
    const evalQuery = routesSrc.split('my_evaluation')[0].split('SELECT technical_competence')[1] || '';
    assert.ok(evalQuery.includes('evaluator_name = $2'), 'الاستعلام لا يقيّد التقييم بالعضو الحالي (تسريب تقييم غيره)');
    assert.ok(routesSrc.includes('if (isModerator)'), 'المنسق لا يجوز أن يرى أي تقييم');

    const roomPage = read('public/InterviewRoom.dc.html');
    assert.ok(roomPage.includes('hydrateExistingEvaluation'), 'الواجهة لا تُحمّل التقييم المحفوظ');
    assert.ok(roomPage.includes('savedEvaluation'), 'لا حالة للتقييم المحفوظ في الواجهة');
    // لا قيم افتراضية عالية تُفرض على العضو
    assert.ok(!/value="4"\s+data-score-key/.test(roomPage), 'المنزلقات ما زالت تُهيَّأ بقيمة 4 افتراضية');
    // الحماية الآن عبر مقارنة الحقول الفعلية (R2) لا عبر حركة المنزلقات
    assert.ok(roomPage.includes('decideEvaluationSave'), 'لا آلية قرار حفظ محكمة');
    assert.ok(roomPage.includes('hydratedFromSaved'), 'لا تتبّع لحالة تحميل التقييم المحفوظ');
  });

  // ---------------------------------------------------------------------------
  await gate('6d', 'R2: قرار الحفظ مقارنة حقول لا حركة منزلقات', async () => {
    const roomPage = read('public/InterviewRoom.dc.html');
    assert.ok(roomPage.includes('function decideEvaluationSave'), 'دالة قرار الحفظ النقية مفقودة');
    assert.ok(roomPage.includes("'block-hydration'"), 'لا حماية من فشل التحميل');
    assert.ok(roomPage.includes("'noop'"), 'لا حالة عدم-تغيير');
    // الثغرة السابقة: الحفظ كان يُمنع لمجرد أن الدرجات لم تُلمس
    assert.ok(!/untouched\.length === Object\.keys\(scores\)\.length/.test(roomPage),
      'شرط "المنزلقات غير الملموسة" ما زال يمنع حفظ الملاحظة وحدها');
    assert.ok(!/untouched\.length && untouched\.length ===/.test(roomPage),
      'شرط الحفظ القديم القائم على المنزلقات عاد للظهور');
    // الحقول الثلاثة القابلة للحفظ وحدها يجب أن تكون في المقارنة
    for (const f of ['notes', 'voice_human_note', 'recommendation']) {
      assert.ok(new RegExp(`current\\.${f}`).test(roomPage), `الحقل ${f} غير مشمول في مقارنة التغيير`);
    }
    // تحقق قبلي من الخادم عند غياب تقييم محمّل
    assert.ok(roomPage.includes('fresh.my_evaluation'), 'لا تحقق قبلي من الخادم قبل الكتابة');
  });

  // ---------------------------------------------------------------------------
  await gate('7', 'telemetry: أحداث idempotent + مدة محسوبة ومقيّدة', async () => {
    const routesSrc = read('services/jitsiRoutes.js');
    for (const ev of ['staff_opened', 'candidate_joined', 'call_ended']) {
      assert.ok(routesSrc.includes(`'${ev}'`), `حدث مفقود: ${ev}`);
    }
    assert.ok(routesSrc.includes('وضع idempotent') || routesSrc.includes('idempotent: true'), 'الأحداث المكررة يجب ألا تُغيّر شيئاً');

    const now = Date.now();
    assert.strictEqual(jitsi.computeActualCallMinutes({ openedAtMs: now - 30 * 60000, closedAtMs: now }), 30);
    assert.strictEqual(jitsi.computeActualCallMinutes({ candidateJoinedAtMs: now - 12 * 60000, closedAtMs: now }), 12);
    // الأسبق بين فتح اللجنة وانضمام المرشح هو بداية المدة
    assert.strictEqual(
      jitsi.computeActualCallMinutes({ openedAtMs: now - 40 * 60000, candidateJoinedAtMs: now - 25 * 60000, closedAtMs: now }),
      40
    );
    assert.strictEqual(jitsi.computeActualCallMinutes({ openedAtMs: now, closedAtMs: now - 600000 }), 0, 'المدة لا تكون سالبة');
    assert.strictEqual(jitsi.computeActualCallMinutes({ openedAtMs: now - 900 * 60000, closedAtMs: now }), 600, 'المدة تُقيَّد بحد القيد');
    assert.strictEqual(jitsi.computeActualCallMinutes({ closedAtMs: now }), 0, 'بلا بداية ⇒ صفر');
  });

  // ---------------------------------------------------------------------------
  await gate('8', 'guard: المقابلة الحضورية مرفوضة في القاعة والقياس', async () => {
    const routesSrc = read('services/jitsiRoutes.js');
    const occurrences = (routesSrc.match(/INTERVIEW_NOT_REMOTE/g) || []).length;
    assert.ok(occurrences >= 2, 'يجب رفض الحضوري في مساري الجلسة والقياس');
    assert.ok(routesSrc.includes('interview_mode === \'in_person\''), 'شرط الحضوري مفقود');
    // لا توليد غرفة لمقابلة حضورية عند الجدولة
    const serverSrc = read('server.js');
    assert.ok(serverSrc.includes("const scheduledRoomName = isRemote && jitsiEnv.enabled ? jitsiClient.generateRoomName() : null"), 'الغرفة تُولَّد للحضوري أيضاً');
  });

  // ---------------------------------------------------------------------------
  await gate('9', 'visit-card: رابط القاعة للمرشح عبر رمز الزيارة فقط', async () => {
    const serverSrc = read('server.js');
    const visitBlock = serverSrc.split("app.get('/api/public/visit/:vt'")[1].split("app.post('/api/public/visit/:vt/confirm'")[0];
    assert.ok(visitBlock.includes('jitsi_room_url'), 'بطاقة الزيارة لا تعرض رابط القاعة');
    assert.ok(visitBlock.includes("role: 'participant'"), 'المرشح يجب أن يدخل participant لا moderator');
    assert.ok(!visitBlock.includes("role: 'moderator'"), 'لا يجوز منح المرشح توكن إدارة');
    // الرابط يُبنى فقط عندما تكون الغرفة مثبتة والمقابلة عن بُعد
    assert.ok(/interview_mode === 'in_person' \|\| !interview\.jitsi_room_name/.test(visitBlock), 'شرط إظهار رابط القاعة غير محكم');
  });

  // ---------------------------------------------------------------------------
  await gate('10', 'leak: لا أسرار ولا بيانات حساسة في مسارات v2.4', async () => {
    const files = ['services/jitsiRoutes.js', 'services/jitsiClient.js', 'public/InterviewRoom.dc.html'];
    const patterns = [
      /process\.env\.JITSI_JWT_SECRET\s*\}/, // طباعة الكائن كاملاً يعني كشف السر
      /BEGIN (RSA|EC|OPENSSH) PRIVATE KEY/,
      /sk_live_[A-Za-z0-9]/,
      /ghp_[A-Za-z0-9]{20,}/,
      /password\s*=\s*['"][^'"]+['"]/
    ];
    for (const f of files) {
      const content = read(f);
      for (const re of patterns) {
        assert.ok(!re.test(content), `تسريب محتمل في ${f}: ${re}`);
      }
      assert.ok(!content.includes('.env.local'), 'لا يجوز الإشارة لملف بيئة محلي');
    }
    const clientSrc = read('services/jitsiClient.js');
    assert.ok(clientSrc.includes('jwtSecret') && !/console\.(log|info)\([^)]*jwtSecret/.test(clientSrc), 'السر لا يُطبع في السجلات');
    // لا يظهر توكن الإدارة في أي صفحة عامة تُقدَّم للمرشح
    const visitPage = read('public/Visit.dc.html');
    assert.ok(!visitPage.includes('jwt'), 'بطاقة المرشح لا يجوز أن تحمل أي توكن');
  });

  // ---------------------------------------------------------------------------
  await gate('11', 'wiring: الصفحات والمسارات مربوطة فعلياً', async () => {
    const serverSrc = read('server.js');
    assert.ok(serverSrc.includes("const jitsiClient = require('./services/jitsiClient')"), 'الخدمة غير مستوردة');
    assert.ok(serverSrc.includes("app.use('/api', createJitsiRoutes({"), 'المسارات غير مربوطة');
    for (const f of ['public/InterviewRoom.dc.html', 'public/Visit.dc.html', 'public/Scheduler.dc.html', 'services/jitsiClient.js', 'services/jitsiRoutes.js']) {
      assert.ok(fs.existsSync(path.join(ROOT, f)), `ملف مفقود: ${f}`);
    }
    const roomPage = read('public/InterviewRoom.dc.html');
    for (const needle of ['/api/interviews/${interviewId}/room-session', 'room-telemetry', '/api/evaluations', 'iframe', 'voice-player']) {
      assert.ok(roomPage.includes(needle), `عنصر مفقود في صفحة القاعة: ${needle}`);
    }
    // الشاشة المقسّمة: فيديو + جانب مرشح/تقييم
    assert.ok(/grid-template-columns:\s*1\.55fr 1fr/.test(roomPage), 'تخطيط الشاشة المقسّمة مفقود');
    assert.ok(read('public/Scheduler.dc.html').includes('InterviewRoom.dc.html?interview_id=${i.id}'), 'صفحة الجدولة لا تربط القاعة');
    assert.ok(read('public/Visit.dc.html').includes('jitsi_room_url'), 'بطاقة الزيارة لا تستخدم رابط القاعة');

    // فحص صياغة JS/HTML المضافة
    execFileSync(process.execPath, ['--check', path.join(ROOT, 'services/jitsiClient.js')]);
    execFileSync(process.execPath, ['--check', path.join(ROOT, 'services/jitsiRoutes.js')]);
    execFileSync(process.execPath, ['--check', path.join(ROOT, 'server.js')]);
    // يُفحص السكربت المضمّن كما هو (تحليل لغوي فقط، لا تنفيذ) — أي خطأ صياغة يسقط البوابة
    const inline = roomPage.split('<script>').pop().split('</script>')[0];
    new Function(inline);
  });

  // ---------------------------------------------------------------------------
  if (results.length !== TOTAL_GATES) {
    console.log(`\n❌ تحقق غير مكتمل: نُفِّذ ${results.length}/${TOTAL_GATES} باباً — العملية انتهت قبل إتمام الفحص.`);
    process.exit(1);
  }

  console.log('\n' + '─'.repeat(72));
  const passed = results.filter((r) => r.ok).length;
  console.log(`v2.4 GATES: ${passed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
  if (failed) {
    console.log('\nفشل الأبواب:');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  • ${r.id} ${r.name}: ${r.error}`));
    process.exit(1);
  }
  console.log('VERIFY_V24_PASSED');
}

let completed = false;
process.on('exit', (code) => {
  if (!completed && code === 0) {
    console.error('❌ verify:v24 خرج قبل إتمام الأبواب (silent early exit) — يُعدّ فشلاً.');
    process.exitCode = 1;
  }
});

main()
  .then(() => { completed = true; })
  .catch((err) => {
    console.error('verify:v24 crashed:', err);
    completed = true;
    process.exit(1);
  });
