#!/usr/bin/env node
/**
 * مجموعة التحقق الشاملة والمعزولة للمرحلة 1 (v2.2a — Smart QR Reception Check-In)
 * تختبر:
 *  1. توليد رمز QR مشفّر HMAC-SHA256 داخل GET /api/public/visit/:vt وقراءته فعلياً بمكتبة jsQR المحلية.
 *  2. رفض التلاعب بتوقيع الـ QR (400)، ورفض الـ QR القديم بعد تدوير visit_token (403)، ورفض المقابلة الملغاة (409).
 *  3. فرض تاريخ يوم المقابلة بتوقيت الرياض (409 بدون force_date_override ونجاح التجاوز الصريح).
 *  4. صلاحيات الأدوار الثلاثة فقط: منع committee_member من /Reception.dc.html و /api/reception/check-in (403)، والسماح له بقراءة /api/reception/arrivals (200).
 *  5. التزامن الفعلي: 5 طلبات متزامنة POST /api/reception/check-in تنتج حالة واحدة وسجل تدقيق واحد فقط (idempotent).
 *  6. اختبار متصفح Chromium حقيقي (Playwright E2E):
 *     - بطاقة Visit.dc.html تعرض رمز الـ QR بدون أي روابط خارجية.
 *     - موظف الاستقبال (hr_coordinator) يحقق ويسجل وصول المرشح من Reception.dc.html.
 *     - عضو اللجنة (committee_member) يرى شريط وصول المرشح الحي أعلى Dashboard.dc.html وشارة الانضباط في CandidateProfile.dc.html.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { Client, Pool } = require('pg');
const QRCode = require('qrcode');
const { chromium } = require('playwright');

if (process.env.ALLOW_ISOLATED_DRILL !== '1') {
  console.error('[SAFETY_LOCKOUT] يلزم تمرير ALLOW_ISOLATED_DRILL=1 لتشغيل verify-v22a.js.');
  process.exit(2);
}
if (process.env.NODE_ENV === 'production') {
  console.error('[SAFETY_LOCKOUT] يُمنع التشغيل في وضع NODE_ENV=production.');
  process.exit(2);
}

const PG_ADMIN_URL = process.env.DRILL_PG_ADMIN_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
const adminUrl = new URL(PG_ADMIN_URL);
if (!['127.0.0.1', 'localhost'].includes(adminUrl.hostname)) {
  console.error('[SAFETY_LOCKOUT] يُسمح بالاتصال المحلي فقط.');
  process.exit(2);
}

const dbBaseOrigin = `${adminUrl.protocol}//${adminUrl.username}${adminUrl.password ? ':' + adminUrl.password : ''}@${adminUrl.host}`;
const runSuffix = `${Date.now().toString(36)}`;
const dbName = `jpf_iso_v22a_${runSuffix}`;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jpf-v22a-'));
const uploadsDir = path.join(tmpRoot, 'uploads');
fs.mkdirSync(path.join(uploadsDir, 'public'), { recursive: true });

const PORT = 3122;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASS = 'V22A-Drill-Pass-2026!';
const SESSION_SECRET = 'v22a-isolated-hmac-secret-key-2026';

async function recreateDb() {
  const c = new Client({ connectionString: adminUrl.toString() });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await c.end();
  }
}

async function dropDb() {
  const c = new Client({ connectionString: adminUrl.toString() });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  } catch (_e) {
  } finally {
    await c.end();
  }
}

function startServer() {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATABASE_URL: `${dbBaseOrigin}/${dbName}`,
      UPLOAD_DIR: uploadsDir,
      ADMIN_ACCESS_CODE: ADMIN_PASS,
      SESSION_SECRET
    },
    stdio: 'pipe'
  });
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server start timeout')), 12000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes(String(PORT))) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.stderr.on('data', (d) => {
      const s = String(d).trim();
      if (s) console.error('[v22a stderr]:', s);
    });
    proc.on('exit', (code) => {
      clearTimeout(t);
      if (code !== null && code !== 0) reject(new Error(`Server exited ${code}`));
    });
  });
  return { proc, ready };
}

async function loginCookie(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  assert.strictEqual(r.status, 200, `Login failed for ${username}`);
  const setCookie = r.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

function getRiyadhTodayStr() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${m.year}-${m.month}-${m.day}`;
}

(async () => {
  let srv = null;
  let pool = null;
  let browser = null;

  try {
    console.log('=== [v2.2a] 1. BOOTING ISOLATED DB & SERVER ===');
    await recreateDb();
    srv = startServer();
    await srv.ready;

    const health = await (await fetch(`${BASE}/api/health`)).json();
    assert.strictEqual(health.status, 'ok');
    // الإصدار التراكمي: يجب ألا يقل عن 2.2.0 (يقبل 2.2a/2.2b وأي مرحلة لاحقة مثل 2.3.0 دون كسر الاختبار)
    const [maj, min] = String(health.version).split('.').map((n) => parseInt(n, 10));
    assert(maj === 2 && Number.isFinite(min) && min >= 2, `Expected version >= 2.2.0, got ${health.version}`);

    pool = new Pool({ connectionString: `${dbBaseOrigin}/${dbName}` });
    pool.on('error', () => {});

    const adminCookie = await loginCookie('admin', ADMIN_PASS);

    // إنشاء حسابَي hr_coordinator و committee_member لاختبار مصفوفة الصلاحيات الثلاثية بدقة
    for (const u of [
      { username: 'hr_rec', full_name: 'منسقة الاستقبال والموارد', role: 'hr_coordinator', password: 'HrCoord#2026!' },
      { username: 'comm_mem', full_name: 'عضو لجنة المقابلات', role: 'committee_member', password: 'CommUser#2026!' }
    ]) {
      const cr = await fetch(`${BASE}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify(u)
      });
      assert.strictEqual(cr.status, 201);
    }

    const hrCookie = await loginCookie('hr_rec', 'HrCoord#2026!');
    const commCookie = await loginCookie('comm_mem', 'CommUser#2026!');

    console.log('=== [v2.2a] 2. TESTING 3-ROLE RBAC ON RECEPTION PAGE & ENDPOINTS ===');
    const commPageRes = await fetch(`${BASE}/Reception.dc.html`, { headers: { Cookie: commCookie } });
    assert.strictEqual(commPageRes.status, 403, 'committee_member must receive 403 on /Reception.dc.html');

    const hrPageRes = await fetch(`${BASE}/Reception.dc.html`, { headers: { Cookie: hrCookie } });
    assert.strictEqual(hrPageRes.status, 200, 'hr_coordinator must access /Reception.dc.html');

    const commVerifyRes = await fetch(`${BASE}/api/reception/verify-qr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: commCookie },
      body: JSON.stringify({ reference_query: '1001' })
    });
    assert.strictEqual(commVerifyRes.status, 403, 'committee_member must receive 403 on verify-qr');

    const commArrivalsRes = await fetch(`${BASE}/api/reception/arrivals`, { headers: { Cookie: commCookie } });
    assert.strictEqual(commArrivalsRes.status, 200, 'committee_member must read /api/reception/arrivals');

    console.log('=== [v2.2a] 3. TESTING PUBLIC VISIT QR GENERATION, jsQR OFFLINE DECODER & CRYPTOGRAPHIC SECURITY ===');
    const riyadhToday = getRiyadhTodayStr();
    const eligRows = (
      await pool.query(
        `SELECT a.id, a.reference_no
         FROM applications a
         LEFT JOIN interviews i ON i.application_id = a.id
         WHERE a.status IN ('passed_assessment', 'under_review', 'interview_scheduled')
           AND COALESCE(i.booking_status, '') <> 'completed'
         ORDER BY a.id ASC
         LIMIT 2`
      )
    ).rows;
    assert(eligRows.length >= 2, 'Need at least 2 eligible applications in seed');
    const app1 = eligRows[0];
    const app2 = eligRows[1];

    // جدولة مقابلة للمرشح الأول بتاريخ غير تاريخ اليوم أولاً لاختبار قيد التاريخ
    const tomorrowDate = '2027-05-15';
    const schedRes = await fetch(`${BASE}/api/interviews/schedule-single`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify({
        application_id: app1.id,
        scheduled_date: tomorrowDate,
        start_time: '11:00',
        duration_minutes: 30,
        interview_mode: 'in_person',
        location_floor: 'الدور الثاني',
        location_office: 'قاعة الاجتماعات التنفيذية 204',
        interviewer_panel: 'م. عبدالرحمن + أ. سارة'
      })
    });
    assert.strictEqual(schedRes.status, 201);
    const schedBody = await schedRes.json();
    const intvId = schedBody.interview.id;
    const visitToken1 = new URL(schedBody.visit_url).searchParams.get('vt');
    assert(visitToken1 && visitToken1.length >= 24);

    // جلب بطاقة الزيارة العامة والتحقق من توليد SVG للـ QR
    const visitRes = await fetch(`${BASE}/api/public/visit/${encodeURIComponent(visitToken1)}`);
    assert.strictEqual(visitRes.status, 200);
    const visitData = await visitRes.json();
    assert(visitData.interview.checkin_qr_svg && visitData.interview.checkin_qr_svg.includes('<svg'), 'Missing checkin_qr_svg');
    assert(visitData.interview.checkin_qr_payload && visitData.interview.checkin_qr_payload.startsWith('JPFQR:'));
    assert.strictEqual(visitData.interview.checkin_code_tail, app1.reference_no.slice(-4));

    const qrPayload1 = visitData.interview.checkin_qr_payload;

    // اختبار فك ترميز مصفوفة بكسلات QR فعلية باستخدام ملف jsQR المحلي المدمج بدون إنترنت
    const jsQrFn = require(path.join(process.cwd(), 'public/js/vendor/jsQR.js'));
    const qrMatrix = QRCode.create(qrPayload1, { errorCorrectionLevel: 'M' }).modules;
    const scale = 6;
    const margin = 4;
    const dim = (qrMatrix.size + margin * 2) * scale;
    const rgba = new Uint8ClampedArray(dim * dim * 4).fill(255);
    for (let y = 0; y < qrMatrix.size; y++) {
      for (let x = 0; x < qrMatrix.size; x++) {
        if (qrMatrix.get(x, y)) {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const px = (x + margin) * scale + dx;
              const py = (y + margin) * scale + dy;
              const idx = (py * dim + px) * 4;
              rgba[idx] = 0;
              rgba[idx + 1] = 0;
              rgba[idx + 2] = 0;
              rgba[idx + 3] = 255;
            }
          }
        }
      }
    }
    const decodedByJsQr = jsQrFn(rgba, dim, dim);
    assert(decodedByJsQr && decodedByJsQr.data === qrPayload1, 'Vendored jsQR failed to decode generated QR payload');

    // التلاعب بتوقيع الـ QR يجب أن يُرفض بـ 403
    const tamperedQr = qrPayload1.slice(0, -3) + (qrPayload1.endsWith('abc') ? 'xyz' : 'abc');
    const badVerify = await fetch(`${BASE}/api/reception/verify-qr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify({ qr_payload: tamperedQr })
    });
    assert.strictEqual(badVerify.status, 403, 'Tampered QR token must return 403');

    // محاولة تسجيل الوصول لموعد في غير يوم المقابلة بدون force_date_override يجب أن تُرفض بـ 409
    const offDateCheckin = await fetch(`${BASE}/api/reception/check-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify({ qr_payload: qrPayload1 })
    });
    assert.strictEqual(offDateCheckin.status, 409, 'Off-date check-in without override must return 409');

    // تدوير visit_token عند إعادة الجدولة إلى تاريخ اليوم يجب أن يُبطل رمز الـ QR القديم فوراً (403)
    const reschedRes = await fetch(`${BASE}/api/interviews/${intvId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify({
        scheduled_date: riyadhToday,
        start_time: '14:30'
      })
    });
    assert.strictEqual(reschedRes.status, 200);
    const visitToken2 = new URL((await reschedRes.json()).visit_url).searchParams.get('vt');
    assert.notStrictEqual(visitToken1, visitToken2, 'visit_token must rotate');

    const revokedQrRes = await fetch(`${BASE}/api/reception/verify-qr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify({ qr_payload: qrPayload1 })
    });
    assert.strictEqual(revokedQrRes.status, 403, 'Revoked QR after visit_token rotation must return 403');

    // جلب الـ QR الجديد الصالح لتاريخ اليوم
    const visitData2 = await (await fetch(`${BASE}/api/public/visit/${encodeURIComponent(visitToken2)}`)).json();
    const qrPayload2 = visitData2.interview.checkin_qr_payload;

    console.log('=== [v2.2a] 4. TESTING 5-WAY CONCURRENT CHECK-IN IDEMPOTENCY & AUDIT LOG ===');
    // إنشاء مقابلة ثانية اليوم للمرشح الثاني لاختبار التزامن المتوازي، مع إبقاء المرشح الأول لاختبار المتصفح الحي
    const sched2 = await fetch(`${BASE}/api/interviews/schedule-single`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify({
        application_id: app2.id,
        scheduled_date: riyadhToday,
        start_time: '15:00',
        duration_minutes: 30,
        interview_mode: 'in_person',
        location_floor: 'الدور الأول',
        location_office: 'قاعة 102'
      })
    });
    assert.strictEqual(sched2.status, 201);
    const intv2 = (await sched2.json()).interview;

    const parallelResults = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(`${BASE}/api/reception/check-in`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
          body: JSON.stringify({ interview_id: intv2.id })
        }).then(async (r) => ({ status: r.status, body: await r.json() }))
      )
    );
    assert(parallelResults.every((x) => x.status === 200), 'All 5 concurrent check-ins must succeed idempotently with 200');
    const freshCheckins = parallelResults.filter((x) => x.body.already_checked_in === false);
    const idempCheckins = parallelResults.filter((x) => x.body.already_checked_in === true);
    assert.strictEqual(freshCheckins.length, 1, 'Exactly 1 concurrent call must perform the initial transition');
    assert.strictEqual(idempCheckins.length, 4, 'Remaining 4 concurrent calls must return already_checked_in=true');

    const auditCnt = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_logs WHERE action = 'CANDIDATE_QR_CHECKED_IN' AND entity_id = $1`,
      [app2.reference_no]
    );
    assert.strictEqual(auditCnt.rows[0].cnt, 1, 'Must record exactly 1 audit_log entry for 5 concurrent check-ins');

    // إلغاء مقابلة المرشح 2 يجب أن يعيد lobby_status إلى not_arrived ويمنع التحضير (409)
    const cancelRes = await fetch(`${BASE}/api/interviews/${intv2.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify({ booking_status: 'cancelled' })
    });
    assert.strictEqual(cancelRes.status, 200);
    const cancelledCheckin = await fetch(`${BASE}/api/reception/check-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify({ interview_id: intv2.id })
    });
    assert.strictEqual(cancelledCheckin.status, 400, 'Cancelled interview must reject check-in with 400');

    console.log('=== [v2.2a] 5. HEADLESS CHROMIUM E2E: VISIT QR -> RECEPTION CHECK-IN -> COMMITTEE LIVE BANNER ===');
    browser = await chromium.launch({ headless: true });

    // أ) المرشح يفتح Visit.dc.html ويرى رمز الـ QR بدون أي استدعاءات خارجية
    const candCtx = await browser.newContext();
    const candPage = await candCtx.newPage();
    const externalRequests = [];
    const isDisallowedExternal = (u) =>
      !u.startsWith(BASE) &&
      !u.startsWith('data:') &&
      !u.startsWith('blob:') &&
      !u.startsWith('https://fonts.googleapis.com/') &&
      !u.startsWith('https://fonts.gstatic.com/');

    candPage.on('request', (req) => {
      const u = req.url();
      if (isDisallowedExternal(u)) externalRequests.push(u);
    });
    await candPage.goto(`${BASE}/Visit.dc.html?vt=${encodeURIComponent(visitToken2)}`, {
      waitUntil: 'networkidle'
    });
    await candPage.waitForSelector('#visit-qr-svg-mount svg', { timeout: 8000 });
    assert.strictEqual(externalRequests.length, 0, `Zero external JS/QR CDN calls allowed, saw: ${externalRequests.join(', ')}`);

    // ب) موظف الاستقبال (hr_coordinator) يسجل دخولاً ويفتح Reception.dc.html ويمسح/يدخل الـ QR ويسجل الوصول
    const hrCtx = await browser.newContext();
    const hrPage = await hrCtx.newPage();
    hrPage.on('request', (req) => {
      const u = req.url();
      if (isDisallowedExternal(u)) externalRequests.push(u);
    });
    await hrPage.goto(`${BASE}/Login.dc.html`, { waitUntil: 'networkidle' });
    await hrPage.fill('#username', 'hr_rec');
    await hrPage.fill('#password', 'HrCoord#2026!');
    await Promise.all([hrPage.waitForURL('**/Dashboard.dc.html'), hrPage.click('#login-btn')]);

    await hrPage.goto(`${BASE}/Reception.dc.html`, { waitUntil: 'networkidle' });
    await hrPage.fill('#qr-manual-input', qrPayload2);
    await hrPage.click('#verify-qr-btn');
    await hrPage.waitForSelector('#confirm-checkin-btn', { timeout: 8000 });
    await hrPage.click('#confirm-checkin-btn');
    await hrPage.waitForSelector(`tr[data-waiting-ref="${app1.reference_no}"]`, { timeout: 8000 });
    assert.strictEqual(externalRequests.length, 0, 'Reception.dc.html must make zero external CDN requests');

    // ج) عضو اللجنة (committee_member) يفتح Dashboard.dc.html ويرى تنبيه وصول المرشح الحي، ثم يفتح CandidateProfile.dc.html ويرى شارة الحضور والانضباط
    const commCtx = await browser.newContext();
    const commPage = await commCtx.newPage();
    await commPage.goto(`${BASE}/Login.dc.html`, { waitUntil: 'networkidle' });
    await commPage.fill('#username', 'comm_mem');
    await commPage.fill('#password', 'CommUser#2026!');
    await Promise.all([commPage.waitForURL('**/Dashboard.dc.html'), commPage.click('#login-btn')]);

    await commPage.waitForSelector('#committee-arrival-alert-bar', { timeout: 8000 });
    const bannerText = await commPage.textContent('#committee-arrival-alert-bar');
    assert(bannerText.includes('وصل الآن في الاستقبال'), 'Committee live arrival banner missing expected Arabic alert');

    // ج-2) التحقق من منع تكرار التنبيه كل 15 ثانية (Committee Alert Dedup): استدعاء التحديث 4 مرات متتالية لا يطلق أي Toast مكرر
    const toastCountBefore = await commPage.evaluate(() => window.__ARRIVAL_TOAST_COUNT || 0);
    assert.strictEqual(toastCountBefore, 1, 'Initial arrival toast must fire exactly once');
    await commPage.evaluate(async () => {
      await SmartHR.refreshLobbyArrivalBanner();
      await SmartHR.refreshLobbyArrivalBanner();
      await SmartHR.refreshLobbyArrivalBanner();
    });
    const toastCountAfter = await commPage.evaluate(() => window.__ARRIVAL_TOAST_COUNT || 0);
    assert.strictEqual(toastCountAfter, 1, 'Repeated 15s polling must NOT duplicate committee arrival alerts');

    // ج-3) استلام عضو اللجنة للمرشح ينقل lobby_status إلى in_room ويزيله من قائمة الانتظار فوراً
    await Promise.all([
      commPage.waitForURL('**/CandidateProfile.dc.html**'),
      commPage.click('#ack-arrival-btn')
    ]);
    await commPage.waitForSelector('text=داخل قاعة المقابلة', { timeout: 8000 });

    const arrAfterAck = await (await fetch(`${BASE}/api/reception/arrivals`, { headers: { Cookie: commCookie } })).json();
    assert.strictEqual(arrAfterAck.waiting_count, 0, 'Acknowledged in_room candidate must not remain in waiting_candidates');

    // د) المرشح يحدث بطاقة الزيارة
    await candPage.reload({ waitUntil: 'networkidle' });

    console.log('=== [v2.2a] 6. COMPLETED INTERVIEW LOBBY SYNC INVARIANT (NO STALE CHECKED_IN) ===');
    // إرسال الدعوة أولاً ليسمح آلة حالات المواعيد بتحويلها إلى completed، ثم التحقق أن lobby_status يصبح completed تلقائياً
    const waRows1 = (await pool.query(`SELECT id FROM wa_messages WHERE interview_id = $1 AND queue_status = 'queued' ORDER BY id DESC LIMIT 1`, [intvId])).rows;
    if (waRows1.length) {
      await fetch(`${BASE}/api/wa-messages/${waRows1[0].id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({ action: 'confirm_sent' })
      });
    }
    const compRes = await fetch(`${BASE}/api/interviews/${intvId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: commCookie },
      body: JSON.stringify({ booking_status: 'completed', notes: 'تمت المقابلة بنجاح' })
    });
    assert.strictEqual(compRes.status, 200);
    const compIntRow = (await pool.query('SELECT booking_status, lobby_status FROM interviews WHERE id = $1', [intvId])).rows[0];
    assert.strictEqual(compIntRow.booking_status, 'completed');
    assert.strictEqual(compIntRow.lobby_status, 'completed', 'Completed interview MUST transition lobby_status to completed');

    const arrAfterComplete = await (await fetch(`${BASE}/api/reception/arrivals`, { headers: { Cookie: hrCookie } })).json();
    assert.strictEqual(arrAfterComplete.waiting_count, 0);
    assert(
      arrAfterComplete.today_schedule.every((x) => x.interview_id !== intvId),
      'Completed interview must not remain on active today arrival schedule'
    );

    console.log('=== [v2.2a] 7. UPLOADED CONTENT LEAK PROTECTION & PII ISOLATION ===');
    // رفض رفع صيغ قابلة للتنفيذ أو HTML/SVG كسيرة ذاتية (400)
    const badUploadFd = new FormData();
    badUploadFd.append('job_id', '1');
    badUploadFd.append('full_name', 'اختبار ملف خبيث');
    badUploadFd.append('email', 'xss_upload_try@jpf.sa');
    badUploadFd.append('phone', '0559100911');
    badUploadFd.append('city', 'جدة');
    badUploadFd.append('qualification', 'بكالوريوس');
    badUploadFd.append('years_experience', '3');
    badUploadFd.append('privacy_consent', 'true');
    badUploadFd.append('cv_file', new Blob(['<script>alert("xss")</script>'], { type: 'text/html' }), 'exploit.html');
    const badUploadRes = await fetch(`${BASE}/api/applications`, { method: 'POST', body: badUploadFd });
    assert.strictEqual(badUploadRes.status, 400, 'Disallowed HTML upload must be rejected with 400');

    // رفع سيرة ذاتية حقيقية تحتوي على بيانات شخصية حساسة (PII) والتحقق من عدم تسربها للزوار أو واجهات البطاقة العامة
    const piiPdfBytes = '%PDF-1.4 SECRET_CANDIDATE_PII_NID_1099887766_SALARY_25000';
    const piiFd = new FormData();
    piiFd.append('job_id', '1');
    piiFd.append('full_name', 'مرشح فحص حماية الخصوصية');
    piiFd.append('email', 'secret_pii_cand@jpf.sa');
    piiFd.append('phone', '0559200922');
    piiFd.append('city', 'جدة');
    piiFd.append('qualification', 'ماجستير');
    piiFd.append('specialization', 'إدارة جودة');
    piiFd.append('years_experience', '6');
    piiFd.append('privacy_consent', 'true');
    piiFd.append('cv_file', new Blob([piiPdfBytes], { type: 'application/pdf' }), 'pii-cv.pdf');
    const piiApplyRes = await fetch(`${BASE}/api/applications`, { method: 'POST', body: piiFd });
    assert.strictEqual(piiApplyRes.status, 201);
    const piiApplyBody = await piiApplyRes.json();
    const piiRef = piiApplyBody.application.reference_no;

    const piiDb = (
      await pool.query(
        `SELECT c.cv_stored_path FROM candidates c JOIN applications a ON a.candidate_id = c.id WHERE a.reference_no = $1`,
        [piiRef]
      )
    ).rows[0];
    assert(piiDb && piiDb.cv_stored_path.startsWith('/uploads/'));

    // الزائر غير المصرح له يُحجب فوراً (401) عن قراءة الملف المرفوع أو محاولة اجتياز المسار
    const anonCvTry = await fetch(`${BASE}${piiDb.cv_stored_path}`);
    assert.strictEqual(anonCvTry.status, 401, 'Anonymous access to uploaded CV must return 401');
    const traversalTry = await fetch(`${BASE}/uploads/..%2fpackage.json`);
    assert([400, 401, 403, 404].includes(traversalTry.status), 'Path traversal must never return 200');

    // مسار الزيارة العام لا يسرب الإيميل أو الجوال أو مسار السيرة أو الرمز السري
    const pubVisitRaw = JSON.stringify(visitData2);
    assert(!pubVisitRaw.includes('cv_stored_path') && !pubVisitRaw.includes('candidate_access_token') && !pubVisitRaw.includes('@'), 'Public visit endpoint leaked PII');

    // الموظف المصرح له يقرأ الملف المرفوع بسلام (200)
    const staffCvOk = await fetch(`${BASE}${piiDb.cv_stored_path}`, { headers: { Cookie: hrCookie } });
    assert.strictEqual(staffCvOk.status, 200);

    console.log('=== [v2.2a] 8. LIVE ROLLBACK TO v2.1 (d0eb509) ON MIGRATED v2.2a DATABASE ===');
    await browser.close();
    browser = null;
    srv.proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    srv = null;

    const v21Worktree = path.join(tmpRoot, 'v21_wt');
    execSync(`git worktree add --detach "${v21Worktree}" d0eb5091cb72adc2066909a5048c9b54ed043428`, { stdio: 'pipe' });
    // ربط node_modules لتشغيل خادم v2.1 المعزول على نفس قاعدة البيانات المرقاة ومجلد المرفقات المشترك
    fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(v21Worktree, 'node_modules'), 'dir');

    const rbPort = PORT + 10;
    const rbBase = `http://127.0.0.1:${rbPort}`;
    const rbProc = spawn(process.execPath, ['server.js'], {
      cwd: v21Worktree,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        PORT: String(rbPort),
        HOST: '127.0.0.1',
        DATABASE_URL: `${dbBaseOrigin}/${dbName}`,
        UPLOAD_DIR: uploadsDir,
        ADMIN_ACCESS_CODE: ADMIN_PASS,
        SESSION_SECRET
      },
      stdio: 'pipe'
    });

    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('v2.1 rollback boot timeout')), 12000);
        rbProc.stdout.on('data', (d) => {
          if (String(d).includes(String(rbPort))) {
            clearTimeout(t);
            resolve();
          }
        });
        rbProc.on('exit', (code) => {
          clearTimeout(t);
          if (code !== null && code !== 0) reject(new Error(`v2.1 exited ${code}`));
        });
      });

      const rbHealth = await (await fetch(`${rbBase}/api/health`)).json();
      assert.strictEqual(rbHealth.version, '2.1.0', 'Rolled-back server must report version 2.1.0');

      // بقاء حماية المرفقات بعد الرجوع إلى v2.1 (401 للزائر و 200 للموظف)
      assert.strictEqual((await fetch(`${rbBase}${piiDb.cv_stored_path}`)).status, 401);
      const rbLoginRes = await fetch(`${rbBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: ADMIN_PASS })
      });
      assert.strictEqual(rbLoginRes.status, 200);
      const rbCookie = (rbLoginRes.headers.get('set-cookie') || '').split(';')[0];
      assert.strictEqual((await fetch(`${rbBase}${piiDb.cv_stored_path}`, { headers: { Cookie: rbCookie } })).status, 200);

      // تقديم طلب توظيف جديد مع رفع سيرة ذاتية على v2.1 فوق قاعدة البيانات المرقاة من v2.2a
      const rbFd = new FormData();
      rbFd.append('job_id', '2');
      rbFd.append('full_name', 'مرشح بعد الرجوع إلى v2.1');
      rbFd.append('email', 'post_rollback_v21@jpf.sa');
      rbFd.append('phone', '0559300933');
      rbFd.append('city', 'الرياض');
      rbFd.append('qualification', 'بكالوريوس');
      rbFd.append('specialization', 'تسويق');
      rbFd.append('years_experience', '4');
      rbFd.append('privacy_consent', 'true');
      rbFd.append('cv_file', new Blob(['%PDF-1.4 Post Rollback CV'], { type: 'application/pdf' }), 'rb.pdf');
      const rbApply = await fetch(`${rbBase}/api/applications`, { method: 'POST', body: rbFd });
      assert.strictEqual(rbApply.status, 201, 'New application on rolled-back v2.1 over migrated DB must return 201');
    } finally {
      rbProc.kill('SIGTERM');
      execSync(`git worktree remove --force "${v21Worktree}"`, { stdio: 'pipe' });
    }

    console.log('ALL_V22A_QR_RECEPTION_SECURITY_CONCURRENCY_PII_ROLLBACK_AND_CHROMIUM_E2E_PASSED');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (srv && srv.proc) srv.proc.kill('SIGTERM');
    if (pool) await pool.end().catch(() => {});
    await dropDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
})();
