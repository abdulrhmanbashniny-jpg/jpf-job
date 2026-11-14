#!/usr/bin/env node
/**
 * verify-v25-live.js — تحقق حيّ شامل لـ v2.5
 * ================================================================================
 * هذا الاختبار لا يعتمد على grep. يبني قاعدة معزولة، يشغّل server.js حقيقياً،
 * يفتح متصفحاً حقيقياً (Playwright/Chromium) ويمرّ بالمسار الكامل المعتمد في الخطة:
 *
 *   1) مقارنة 3 مرشحين في صفحة Compare.dc.html الحقيقية
 *   2) إصدار عرض وظيفي بصفة hr_coordinator من صفحة OfferLetter.dc.html
 *   3) توليد PDF عربي + تخزين pdf_sha256 + التحقق من التطابق على القرص
 *   4) مرشح مجهول يفتح OfferView.dc.html?ot=... ويوقّع (اسم رباعي + هوية + تاريخ)
 *   5) تحوّل الحالة إلى hired في القاعدة فعلياً
 *   6) وصول حزمة JSON كاملة وموقّعة HMAC إلى مستقبل n8n محلي
 *   7) صمود العمليات عند تعطّل n8n تماماً (لا فشل للتوظيف)
 *
 * قيود الأمان: ALLOW_ISOLATED_DRILL=1 + NODE_ENV != production + قاعدة محلية فقط.
 * لا اتصال خارجي، لا واتساب حقيقي، لا أسرار إنتاج.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Client, Pool } = require('pg');
const { chromium } = require('playwright');

if (process.env.ALLOW_ISOLATED_DRILL !== '1') {
  console.error('[SAFETY_LOCKOUT] يلزم تمرير ALLOW_ISOLATED_DRILL=1 لتشغيل verify-v25-live.js.');
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
const dbName = `jpf_iso_v25_${Date.now().toString(36)}`;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jpf-v25-'));
const uploadsDir = path.join(tmpRoot, 'uploads');
fs.mkdirSync(path.join(uploadsDir, 'offers'), { recursive: true });

const PORT = 3125;
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK_PORT = 5679;
const ADMIN_PASS = 'V25-Drill-Pass-2026!';
const SESSION_SECRET = 'v25-isolated-hmac-secret-key-2026';
const N8N_SECRET = 'v25-drill-n8n-hmac-secret-not-real-0123456789abcdef';

const stamp = String(Date.now()).slice(-7);
const DRILL_PHONE = `056${stamp}`;
const CAND_NAME = 'محمد عبدالله سعيد الأحمدي';
// رقم هوية اصطناعي (10 أرقام) يُولَّد وقت التشغيل — ليس رقماً حقيقياً
const NATIONAL_ID = ('10' + stamp + '11').slice(0, 10);
const TOTAL_GATES = 12;

let srv = null;
let pool = null;
let browser = null;
let mock = null;
let mockReceived = [];
let adminCookie = null;
let hrCookie = null;
let commCookie = null;
let compareIds = [];
let issuedOffer = null;
let candidateToken = null;

const results = [];
let failed = 0;

/** تاريخ ISO محلي من Date أو نص، بلا انزياح للمنطقة الزمنية */
function toIsoDate(v) {
  if (!v) return '';
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

async function gate(id, name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ id, name, ok: true });
    console.log(`  ✅ ${id}. ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    failed += 1;
    results.push({ id, name, ok: false, error: err.message });
    console.log(`  ❌ ${id}. ${name} → ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
async function recreateDb() {
  const c = new Client({ connectionString: adminUrl.toString() });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${dbName}`);
  } finally { await c.end(); }
}

async function runInitDb() {
  const proc = spawn(process.execPath, ['scripts/init-db.js'], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, DATABASE_URL: `${dbBaseOrigin}/${dbName}`, NODE_ENV: 'test' },
    stdio: 'pipe'
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += String(d); });
  proc.stderr.on('data', (d) => { out += String(d); });
  const code = await new Promise((resolve) => proc.on('exit', resolve));
  if (code !== 0) throw new Error(`init-db failed (${code}): ${out.slice(-900)}`);
  return out;
}

function waitForPortFree(port, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.once('connect', () => { sock.destroy(); retry(); });
      sock.once('error', () => { sock.destroy(); resolve(true); });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(attempt, 150);
    };
    attempt();
  });
}

function startServer(extraEnv = {}) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    detached: true,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATABASE_URL: `${dbBaseOrigin}/${dbName}`,
      UPLOAD_DIR: uploadsDir,
      ADMIN_ACCESS_CODE: ADMIN_PASS,
      SESSION_SECRET,
      WAHA_DRY_RUN: 'true',
      WAHA_LIVE_APPROVED: 'false',
      OUTBOX_WORKER_INTERVAL_MS: '700',
      ...extraEnv
    },
    stdio: 'pipe'
  });
  const capture = { stdout: '', stderr: '' };
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server start timeout')), 25000);
    proc.stdout.on('data', (d) => {
      capture.stdout += String(d);
      if (String(d).includes(String(PORT))) { clearTimeout(t); resolve(); }
    });
    proc.stderr.on('data', (d) => {
      capture.stderr += String(d);
      const s = String(d).trim();
      if (s && !/DeprecationWarning|ExperimentalWarning/.test(s)) console.error('[v25 stderr]:', s.slice(0, 300));
    });
    proc.on('exit', (code) => {
      clearTimeout(t);
      if (code !== null && code !== 0) reject(new Error(`Server exited ${code}\n${capture.stderr.slice(-700)}`));
    });
  });
  return { proc, ready, capture };
}

async function stopServer(target) {
  if (!target || !target.proc || target.proc.killed) return;
  const proc = target.proc;
  const exited = new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', resolve);
  });
  try { process.kill(-proc.pid, 'SIGTERM'); } catch (_e) { try { proc.kill('SIGTERM'); } catch (_e2) {} }
  const timedOut = await Promise.race([exited.then(() => false), new Promise((r) => setTimeout(() => r(true), 5000))]);
  if (timedOut) {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch (_e) { try { proc.kill('SIGKILL'); } catch (_e2) {} }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  }
  await waitForPortFree(PORT);
}

async function loginCookie(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  assert.strictEqual(r.status, 200, `Login failed for ${username}: ${r.status}`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

async function api(pathname, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.cookie) headers.Cookie = opts.cookie;
  let body;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const r = await fetch(`${BASE}${pathname}`, { method: opts.method || 'GET', headers, body });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) { /* غير JSON */ }
  return { status: r.status, json, text, headers: r.headers };
}

/** مستقبل n8n محلي: يسجّل كل حزمة، ويتحقق من توقيع HMAC بنفسه */
function startMockListener() {
  mockReceived = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const sig = req.headers['x-jpf-signature'] || '';
      const m = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(sig);
      let signatureValid = false;
      if (m) {
        const expected = crypto.createHmac('sha256', N8N_SECRET).update(`${m[1]}.${raw}`).digest('hex');
        const a = Buffer.from(expected, 'hex');
        const b = Buffer.from(m[2], 'hex');
        signatureValid = a.length === b.length && crypto.timingSafeEqual(a, b);
        const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(m[1]));
        if (skew > 300) signatureValid = false;
      }
      let payload = null;
      try { payload = JSON.parse(raw); } catch (_e) { /* خام */ }
      mockReceived.push({
        event: req.headers['x-jpf-event'],
        delivery: req.headers['x-jpf-delivery'],
        signatureValid,
        raw,
        payload
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('\n🧪 verify:v25-live — المسار الكامل: مقارنة ← عرض ← توقيع ← hired ← n8n\n');
  console.log(`   قاعدة التحقق: ${dbName}`);
  console.log(`   مجلد الرفع:   ${uploadsDir}\n`);

  await recreateDb();
  const initOut = await runInitDb();
  console.log('   init-db:', initOut.trim().split('\n').slice(-1)[0]);

  pool = new Pool({ connectionString: `${dbBaseOrigin}/${dbName}` });

  const seedApp = await pool.query('SELECT id, job_id FROM applications ORDER BY id LIMIT 1');
  assert.ok(seedApp.rows.length, 'لا توجد طلبات في القاعدة الأولية');
  const jobId = seedApp.rows[0].job_id;

  // أضف مرشحين إضافيين للوصول إلى 3 مرشحين قابلين للمقارنة على نفس الوظيفة
  const extra = await pool.query(
    `INSERT INTO candidates (full_name, phone, email, national_id, years_experience)
     VALUES ($1,$2,$3,$4,5), ($5,$6,$7,$8,3)
     RETURNING id, full_name`,
    [CAND_NAME, DRILL_PHONE, `c1.${stamp}@drill.invalid`, NATIONAL_ID,
      'سارة فهد ناصر القحطاني', `057${stamp}`, `c2.${stamp}@drill.invalid`, ('20' + stamp + '12').slice(0, 10)]
  );
  for (const c of extra.rows) {
    // الحالة الصحيحة: passed_assessment (لايوجد assessment_done في المخطط)
    await pool.query(
      `INSERT INTO applications (reference_no, candidate_id, job_id, status, assessment_score, ai_overall_score)
       VALUES ($3,$1,$2,'passed_assessment',75,72)`,
      [c.id, jobId, `ISO-V25-${String(c.id).padStart(6, '0')}-${stamp}`]
    );
  }

  const apps = await pool.query(
    `SELECT a.id, c.full_name FROM applications a
     JOIN candidates c ON c.id = a.candidate_id
     WHERE a.job_id = $1 ORDER BY a.id LIMIT 3`, [jobId]
  );
  compareIds = apps.rows.map((r) => r.id);
  assert.strictEqual(compareIds.length, 3, 'تعذّر تجهيز 3 مرشحين');
  console.log(`   مرشحو المقارنة: ${apps.rows.map((r) => r.full_name).join(' | ')}\n`);

  mock = await startMockListener();

  srv = startServer({
    N8N_WEBHOOK_ENABLED: 'true',
    N8N_OFFER_WEBHOOK_URL: `http://127.0.0.1:${MOCK_PORT}/webhook/jpf-hr-offers`,
    N8N_WEBHOOK_SECRET: N8N_SECRET,
    N8N_ALLOW_LOOPBACK_FOR_TESTS: '1'
  });
  await srv.ready;
  console.log('   ✅ الخادم يعمل على ' + BASE + '\n');

  adminCookie = await loginCookie('admin', ADMIN_PASS);
  for (const u of [
    { username: 'hr_v25', full_name: 'منسقة التوظيف', role: 'hr_coordinator', password: 'HrUser#2026!' },
    { username: 'comm_v25', full_name: 'عضو لجنة التوظيف', role: 'committee_member', password: 'CommUser#2026!' }
  ]) {
    const cr = await api('/api/users', { method: 'POST', cookie: adminCookie, body: u });
    assert.ok([200, 201].includes(cr.status), `إنشاء مستخدم ${u.username} فشل: ${cr.status} ${cr.text.slice(0, 200)}`);
  }
  hrCookie = await loginCookie('hr_v25', 'HrUser#2026!');
  commCookie = await loginCookie('comm_v25', 'CommUser#2026!');

  browser = await chromium.launch({ args: ['--no-sandbox'] });

  // =========================================================================
  await gate('1', 'migration: جداول وأعمدة v2.5 موجودة فعلياً في القاعدة', async () => {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'job_offers'`
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const c of ['offer_ref', 'offer_token', 'pdf_sha256', 'pdf_stored_path', 'total_monthly_salary',
      'candidate_signed_name', 'candidate_national_id', 'candidate_agreed_start_date', 'signed_at',
      'signer_ip', 'n8n_sync_status']) {
      assert.ok(names.includes(c), `عمود مفقود: ${c}`);
    }
    const outboxCols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'automation_outbox'`
    );
    const onames = outboxCols.rows.map((r) => r.column_name);
    for (const c of ['event_type', 'aggregate_type', 'aggregate_id', 'payload', 'payload_sha256',
      'delivery_status', 'attempt_count', 'idempotency_key', 'next_attempt_at']) {
      assert.ok(onames.includes(c), `عمود مفقود في outbox: ${c}`);
    }
    // عمود محسوب فعلياً
    const gen = await pool.query(
      `SELECT is_generated, generation_expression FROM information_schema.columns
       WHERE table_name='job_offers' AND column_name='total_monthly_salary'`
    );
    assert.strictEqual(gen.rows[0].is_generated, 'ALWAYS', 'الإجمالي ليس عموداً محسوباً');
    // القالب مزروع في system_settings
    const tpl = await pool.query(
      `SELECT setting_value FROM system_settings WHERE setting_key = 'offer_template_config'`
    );
    assert.ok(tpl.rows.length === 1, 'قالب العرض غير مزروع في system_settings');
    const tplVal = tpl.rows[0].setting_value;
    assert.ok(tplVal && typeof tplVal === 'object', 'قيمة القالب ليست كائناً');
    assert.ok(String(tplVal.company_name || '').length > 0, 'اسم الشركة مفقود من القالب');
    assert.ok(String(tplVal.template_version || '').length > 0, 'إصدار القالب مفقود');
  });

  // =========================================================================
  await gate('2', 'compare API: 2–4 مرشحين، نفس الوظيفة، والحماية من الخلط', async () => {
    const ok = await api(`/api/compare?ids=${compareIds.join(',')}`, { cookie: commCookie });
    assert.strictEqual(ok.status, 200, `المقارنة فشلت: ${ok.status} ${ok.text.slice(0, 300)}`);
    assert.strictEqual(ok.json.candidates.length, 3, 'عدد المرشحين المُعاد غير صحيح');
    assert.strictEqual(ok.json.count, 3, 'العدّاد لا يطابق عدد المرشحين');
    assert.strictEqual(ok.json.can_issue_offers, false, 'عضو اللجنة لا يملك حق إصدار العروض');
    const hrView = await api(`/api/compare?ids=${compareIds.join(',')}`, { cookie: hrCookie });
    assert.strictEqual(hrView.json.can_issue_offers, true, 'المنسق يجب أن يملك حق الإصدار');
    for (const c of ok.json.candidates) {
      assert.ok(c.full_name, 'اسم المرشح مفقود');
      assert.ok('cv_summary' in c, 'ملخص السيرة مفقود');
      assert.ok('scores' in c, 'الدرجات مفقودة');
      assert.ok('recommendation_summary' in c, 'خلاصة توصيات اللجنة مفقودة');
      assert.ok('committee' in c && c.committee.criteria_averages, 'معايير اللجنة مفقودة');
      assert.ok('has_national_id' in c, 'علم وجود رقم الهوية مفقود');
      assert.ok(!('offer_token' in c) && !('national_id' in c), 'تسريب بيانات حساسة في المقارنة');
    }
    const one = await api(`/api/compare?ids=${compareIds[0]}`, { cookie: commCookie });
    assert.strictEqual(one.status, 400, 'مرشح واحد يجب أن يُرفض');
    const tooMany = await api(`/api/compare?ids=1,2,3,4,5`, { cookie: commCookie });
    assert.strictEqual(tooMany.status, 400, 'أكثر من 4 يجب أن يُرفض');
  });

  // =========================================================================
  await gate('3', 'RBAC: اللجنة تُوصي ولا تُصدر عرضاً', async () => {
    const denied = await api('/api/offers', {
      method: 'POST', cookie: commCookie,
      body: {
        application_id: compareIds[0], basic_salary: 12000, housing_allowance: 3000,
        transport_allowance: 800, other_allowances: 200, expected_start_date: '2026-12-01'
      }
    });
    assert.strictEqual(denied.status, 403, `عضو اللجنة أصدر عرضاً! (${denied.status})`);
    const tpl = await api('/api/offers/template', { cookie: commCookie });
    assert.strictEqual(tpl.status, 403, 'اللجنة لا يجب أن تعدّل القالب');
    const anon = await api('/api/offers');
    assert.ok([401, 403].includes(anon.status), 'المسار مفتوح بدون مصادقة');
  });

  // =========================================================================
  await gate('4', 'المتصفح: Compare.dc.html يعرض 3 مرشحين فعلياً', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    await ctx.addCookies([{ name: hrCookie.split('=')[0], value: hrCookie.split('=').slice(1).join('='), url: BASE }]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/Compare.dc.html?ids=${compareIds.join(',')}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="compare-grid"]', { timeout: 15000 });
    const cols = await page.locator('[data-testid="compare-grid"] > *').count();
    assert.ok(cols >= 3, `عدد أعمدة المقارنة ${cols} أقل من 3`);
    const text = await page.locator('body').innerText();
    assert.ok(text.includes(apps.rows[0].full_name) || text.includes(CAND_NAME), 'أسماء المرشحين لا تظهر');
    const btn = page.locator('[data-testid="issue-offer"]').first();
    assert.ok(await btn.count() > 0, 'زر إصدار العرض غير موجود للمنسق');
    assert.deepStrictEqual(errors, [], `أخطاء JS في الصفحة: ${errors.join(' | ')}`);
    await ctx.close();
  });

  // =========================================================================
  await gate('5', 'المتصفح: hr_coordinator يُصدر عرضاً ويُولَّد PDF عربي', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
    await ctx.addCookies([{ name: hrCookie.split('=')[0], value: hrCookie.split('=').slice(1).join('='), url: BASE }]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/OfferLetter.dc.html?application_id=${compareIds[0]}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#issuer', { state: 'visible', timeout: 15000 });

    await page.fill('#basic_salary', '12000');
    await page.fill('#housing_allowance', '3000');
    await page.fill('#transport_allowance', '800');
    await page.fill('#other_allowances', '200');
    await page.fill('#expected_start_date', '2026-12-01');
    await page.dispatchEvent('#basic_salary', 'input');
    await page.waitForTimeout(150);
    const totalText = await page.locator('#sum-total').innerText();
    assert.strictEqual(totalText.replace(/,/g, ''), '16000.00', `الإجمالي المعروض خاطئ: ${totalText}`);

    const respPromise = page.waitForResponse((r) => r.url().includes('/api/offers') && r.request().method() === 'POST');
    await page.click('#btn-issue');
    const resp = await respPromise;
    const body = await resp.json();
    assert.strictEqual(resp.status(), 201, `إصدار العرض فشل: ${resp.status()} ${JSON.stringify(body).slice(0, 300)}`);
    issuedOffer = body.offer;
    // الاسم الحقيقي للمرشح المقارَن (قد يكون من بيانات البذرة لا المرشح المُضاف)
    const cmp = await api(`/api/compare?ids=${compareIds.join(',')}`, { cookie: hrCookie });
    const subject = cmp.json.candidates.find((c) => Number(c.id) === compareIds[0]);
    issuedOffer.subject_name = subject.full_name;
    issuedOffer.subject_national_id = subject.has_national_id ? NATIONAL_ID : null;

    await page.waitForSelector('#issued-panel', { state: 'visible', timeout: 10000 });
    const issuedText = await page.locator('#issued-details').innerText();
    assert.ok(issuedText.includes(issuedOffer.offer_ref), 'رقم العرض لا يظهر');
    assert.ok(issuedText.includes(issuedOffer.pdf_sha256), 'بصمة PDF لا تُعرض');
    candidateToken = issuedOffer.candidate_url.split('ot=')[1];
    assert.ok(/^[a-f0-9]{64}$/.test(candidateToken), 'التوكن المُعاد غير صالح');
    assert.deepStrictEqual(errors, [], `أخطاء JS: ${errors.join(' | ')}`);
    await ctx.close();
  });

  // =========================================================================
  await gate('6', 'PDF: عربي، بصمة مطابقة على القرص، ومحتوى صحيح', async () => {
    const row = await pool.query(
      `SELECT pdf_sha256, pdf_stored_path, total_monthly_salary, offer_status, offer_token, offer_ref
       FROM job_offers WHERE id = $1`, [issuedOffer.id]
    );
    const o = row.rows[0];
    assert.strictEqual(o.offer_status, 'issued', `حالة العرض غير متوقعة: ${o.offer_status}`);
    assert.ok(!/^[a-f0-9]{64}$/.test(o.offer_token) === false, 'التوكن لم يُخزَّن مُهشّراً');
    assert.strictEqual(o.offer_token, crypto.createHash('sha256').update(candidateToken).digest('hex'),
      'التوكن المخزّن لا يطابق بصمة التوكن المُسلَّم');
    assert.notStrictEqual(o.offer_token, candidateToken, 'التوكن الخام مخزَّن في القاعدة!');

    assert.strictEqual(Number(o.total_monthly_salary), 16000, 'الإجمالي المحسوب خطأ');

    const abs = path.join(uploadsDir, o.pdf_stored_path);
    assert.ok(fs.existsSync(abs), `ملف PDF غير موجود: ${abs}`);
    const bytes = fs.readFileSync(abs);
    assert.strictEqual(bytes.slice(0, 5).toString(), '%PDF-', 'الملف ليس PDF');
    const diskSha = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.strictEqual(diskSha, o.pdf_sha256, 'بصمة القاعدة لا تطابق الملف على القرص');

    // تنزيل عبر الـ API ومقارنة البايتات
    const dl = await fetch(`${BASE}/api/offers/${issuedOffer.id}/pdf`, { headers: { Cookie: hrCookie } });
    assert.strictEqual(dl.status, 200, `تنزيل PDF فشل: ${dl.status}`);
    const dlBuf = Buffer.from(await dl.arrayBuffer());
    assert.strictEqual(crypto.createHash('sha256').update(dlBuf).digest('hex'), o.pdf_sha256,
      'PDF المُنزَّل مختلف عن المخزَّن');

    // الخط العربي مضمَّن (فحص بعد فك الضغط)
    const zlib = require('zlib');
    const raw = dlBuf.toString('latin1');
    let inflated = '';
    let m;
    const re = /stream\r?\n/g;
    while ((m = re.exec(raw)) !== null) {
      const start = m.index + m[0].length;
      const end = raw.indexOf('endstream', start);
      if (end < 0) continue;
      try { inflated += zlib.inflateSync(dlBuf.subarray(start, end)).toString('latin1'); } catch (_e) {}
    }
    assert.ok(/Amiri/i.test(inflated + raw), 'الخط العربي غير مضمَّن في PDF');
  });

  // =========================================================================
  await gate('7', 'outbox: حزمة offer.issued وصلت موقّعة إلى n8n المحلي', async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const evt = mockReceived.find((e) => e.event === 'offer.issued' && e.payload && e.payload.aggregate
      && String(e.payload.aggregate.id) === String(issuedOffer.id));
    assert.ok(evt, `لم تصل حزمة offer.issued (وصل: ${mockReceived.map((e) => e.event).join(',')})`);
    assert.strictEqual(evt.signatureValid, true, 'توقيع HMAC غير صحيح لدى المستقبل');
    const p = evt.payload;
    assert.strictEqual(p.event, 'offer.issued');
    assert.ok(p.idempotency_key.includes(issuedOffer.offer_ref), 'مفتاح التكرار لا يذكر رقم العرض');
    assert.ok(p.payload.candidate_name, 'اسم المرشح مفقود من الحزمة');
    assert.ok(p.payload.total_monthly_salary === 16000 || Number(p.payload.total_monthly_salary) === 16000,
      'الإجمالي مفقود من الحزمة');
    assert.ok(p.payload.pdf_sha256 === issuedOffer.pdf_sha256, 'بصمة PDF لا تُنقل للـ n8n');
    assert.ok(!JSON.stringify(p).includes(candidateToken), 'التوكن الخام تسرّب إلى n8n!');
    const ob = await pool.query(
      `SELECT delivery_status, attempt_count FROM automation_outbox WHERE event_type='offer.issued' ORDER BY id DESC LIMIT 1`
    );
    assert.strictEqual(ob.rows[0].delivery_status, 'delivered', `حالة التسليم: ${ob.rows[0].delivery_status}`);
  });

  // =========================================================================
  await gate('8', 'المرشح (مجهول): يفتح الرابط ويوقّع بالاسم الرباعي والهوية', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 1200 } }); // بلا كوكيز
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/OfferView.dc.html?ot=${candidateToken}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#content', { state: 'visible', timeout: 15000 });
    const shown = await page.locator('body').innerText();
    assert.ok(shown.includes(String(issuedOffer.offer_ref)), 'رقم العرض لا يظهر للمرشح');
    assert.ok(shown.includes('16,000.00'), 'الإجمالي لا يظهر للمرشح');

    // رفض: اسم غير مطابق أو هوية ناقصة
    await page.fill('#signed_name', 'اسم مختلف تماماً');
    await page.fill('#national_id', '1234567890');
    await page.click('#btn-accept');
    await page.waitForTimeout(400);
    const stillThere = await page.locator('#sign-box').isVisible();
    assert.strictEqual(stillThere, true, 'الاسم غير المطابق قُبل!');

    // توقيع صحيح
    // إن كان للمرشح رقم هوية مسجَّل، يجب أن يُطابق؛ وإلا فأي رقم صحيح الشكل يُقبل
    const signId = issuedOffer.subject_national_id || '1234567890';
    await page.fill('#signed_name', issuedOffer.subject_name);
    await page.fill('#national_id', signId);
    await page.fill('#agreed_start_date', '2026-12-01');
    const respPromise = page.waitForResponse((r) => r.url().includes('/respond'));
    await page.click('#btn-accept');
    const resp = await respPromise;
    const body = await resp.json();
    assert.strictEqual(resp.status(), 200, `التوقيع فشل: ${resp.status()} ${JSON.stringify(body).slice(0, 300)}`);
    await page.waitForSelector('#final-state', { state: 'visible', timeout: 8000 });
    const finalText = await page.locator('#final-state').innerText();
    assert.ok(finalText.includes('تم قبول'), `حالة نهائية غير متوقعة: ${finalText}`);
    assert.deepStrictEqual(errors, [], `أخطاء JS: ${errors.join(' | ')}`);
    await ctx.close();
  });

  // =========================================================================
  await gate('9', 'الحالة النهائية: hired في القاعدة + أثر التوقيع كامل', async () => {
    const app = await pool.query(`SELECT status FROM applications WHERE id = $1`, [compareIds[0]]);
    assert.strictEqual(app.rows[0].status, 'hired', `حالة الطلب: ${app.rows[0].status}`);
    const off = await pool.query(
      `SELECT offer_status, candidate_signed_name, candidate_national_id, signed_at,
              candidate_agreed_start_date, signer_ip, n8n_sync_status, updated_at
       FROM job_offers WHERE id = $1`, [issuedOffer.id]
    );
    const o = off.rows[0];
    assert.strictEqual(o.offer_status, 'accepted');
    assert.strictEqual(o.candidate_signed_name, issuedOffer.subject_name);
    assert.ok(o.candidate_signed_name.trim().split(/\s+/).length >= 2, 'الاسم الموقَّع غير مكتمل');
    assert.ok(/^[0-9]{10}$/.test(o.candidate_national_id), 'رقم الهوية غير مسجَّل صحيحاً');
    assert.ok(o.signed_at, 'وقت التوقيع غير مسجَّل');
    assert.strictEqual(toIsoDate(o.candidate_agreed_start_date), '2026-12-01',
      'تاريخ المباشرة غير مسجَّل');
    assert.ok(o.signer_ip, 'عنوان IP للتوقيع غير مسجَّل');

    // رفض إعادة الاستخدام
    const again = await api(`/api/public/offers/${candidateToken}/respond`, {
      method: 'POST', body: { decision: 'accept', signed_name: issuedOffer.subject_name,
                national_id: issuedOffer.subject_national_id || '1234567890' }
    });
    assert.ok([409, 410].includes(again.status), `إعادة التوقيع قُبلت! (${again.status})`);
  });

  // =========================================================================
  await gate('10', 'outbox: offer.accepted وصل بعد التوقيع', async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const evt = mockReceived.find((e) => e.event === 'offer.accepted');
    assert.ok(evt, `لم تصل حزمة offer.accepted (وصل: ${mockReceived.map((e) => e.event).join(',')})`);
    assert.strictEqual(evt.signatureValid, true, 'توقيع offer.accepted غير صحيح');
    assert.strictEqual(evt.payload.payload.offer_status, 'accepted');
    assert.strictEqual(evt.payload.payload.application_status, 'hired');
    const rows = await pool.query(`SELECT COUNT(*)::int AS n FROM automation_outbox`);
    assert.ok(rows.rows[0].n >= 2, 'عدد أحداث الصندوق أقل من المتوقع');
  });

  // =========================================================================
  await gate('11', 'صمود: تعطّل n8n تماماً لا يُفشل أي عملية توظيف', async () => {
    // إصدار عرض ثانٍ بينما المستقبل مطفأ
    await new Promise((resolve) => mock.close(resolve));
    mock = null;
    const second = await api('/api/offers', {
      method: 'POST', cookie: hrCookie,
      body: {
        application_id: compareIds[1], basic_salary: 9000, housing_allowance: 2000,
        transport_allowance: 500, expected_start_date: '2026-12-15'
      }
    });
    assert.strictEqual(second.status, 201, `إصدار العرض فشل بسبب n8n! (${second.status})`);
    const row = await pool.query(
      `SELECT pdf_sha256, offer_status FROM job_offers WHERE id = $1`, [second.json.offer.id]
    );
    assert.strictEqual(row.rows[0].offer_status, 'issued');
    assert.ok(/^[a-f0-9]{64}$/.test(row.rows[0].pdf_sha256), 'PDF لم يُولَّد عند تعطل n8n');
    const pdfResp = await fetch(`${BASE}/api/offers/${second.json.offer.id}/pdf`, { headers: { Cookie: hrCookie } });
    assert.strictEqual(pdfResp.status, 200, 'ملف PDF غير متاح عند تعطل n8n');

    // الحدث يبقى في الصندوق بحالة فشل قابلة لإعادة المحاولة (لا ضياع)
    await new Promise((r) => setTimeout(r, 2500));
    const ob = await pool.query(
      `SELECT delivery_status, attempt_count, last_error FROM automation_outbox
       WHERE event_type='offer.issued' AND aggregate_id = $1`, [second.json.offer.id]
    );
    assert.ok(ob.rows.length >= 1, 'الحدث لم يُسجَّل في الصندوق إطلاقاً');
    assert.ok(['pending', 'failed'].includes(ob.rows[0].delivery_status),
      `حالة غير متوقعة: ${ob.rows[0].delivery_status}`);
    assert.ok(ob.rows[0].attempt_count >= 1, 'لم تُسجَّل أي محاولة تسليم');

    // والرد العام للمرشح لا يزال يعمل
    const view = await fetch(`${BASE}/api/public/offers/${second.json.offer.candidate_url.split('ot=')[1]}`);
    assert.strictEqual(view.status, 200, 'صفحة العرض لا تعمل عند تعطل n8n');

    // استئناف المستقبل ← الأحداث المعلّقة تُسلَّم
    mock = await startMockListener();
    const flush = await api('/api/automation/outbox-status', { cookie: adminCookie });
    assert.strictEqual(flush.status, 200, 'فحص حالة الصندوق فشل');
    assert.ok(flush.json.stats, 'إحصاءات الصندوق مفقودة');
    await new Promise((r) => setTimeout(r, 3000));
  });

  // =========================================================================
  await gate('12', 'الإيقاف الافتراضي: بلا N8N_WEBHOOK_ENABLED لا شيء يُرسَل', async () => {
    await stopServer(srv);
    srv = startServer({ N8N_WEBHOOK_ENABLED: 'false' });
    await srv.ready;
    hrCookie = await loginCookie('hr_v25', 'HrUser#2026!');
    const before = mockReceived.length;
    const third = await api('/api/offers', {
      method: 'POST', cookie: hrCookie,
      body: { application_id: compareIds[2], basic_salary: 8000, expected_start_date: '2027-01-05' }
    });
    assert.strictEqual(third.status, 201, 'الإصدار فشل عند تعطيل الأتمتة');
    await new Promise((r) => setTimeout(r, 2000));
    const leaked = mockReceived.slice(before).filter((e) => e.event === 'offer.issued');
    assert.strictEqual(leaked.length, 0, `أُرسلت ${leaked.length} حزمة رغم التعطيل!`);
    // الصندوق لا يُعدّل حالة الصفوف إطلاقاً عند التعطيل: تبقى pending كما هي
    const ob = await pool.query(
      `SELECT delivery_status, attempt_count FROM automation_outbox
       WHERE aggregate_id = $1 AND event_type='offer.issued'`, [third.json.offer.id]
    );
    assert.ok(ob.rows.length === 1, 'الحدث لم يُسجَّل في الصندوق');
    assert.strictEqual(ob.rows[0].delivery_status, 'pending',
      `الحالة يجب أن تبقى pending، وجدنا ${ob.rows[0].delivery_status}`);
    assert.strictEqual(ob.rows[0].attempt_count, 0, 'وُجدت محاولة تسليم رغم التعطيل');
    const status = await api('/api/automation/outbox-status', { cookie: hrCookie });
    assert.strictEqual(status.json.delivery_enabled, false, 'الحالة تُظهر تسليماً مفعّلاً!');
    assert.strictEqual(status.json.secret_configured, false, 'السر يُقرأ رغم التعطيل');
  });

  // =========================================================================
  if (results.length !== TOTAL_GATES) {
    console.log(`\n❌ عدد الأبواب ${results.length}/${TOTAL_GATES} — تحقق غير مكتمل.`);
    failed += 1;
  }
  console.log('\n' + '─'.repeat(74));
  const passed = results.filter((r) => r.ok).length;
  console.log(`v2.5 LIVE GATES: ${passed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
  if (failed) {
    results.filter((r) => !r.ok).forEach((r) => console.log(`  • ${r.id} ${r.name}: ${r.error}`));
  } else {
    console.log('VERIFY_V25_LIVE_PASSED');
  }
}

// ---------------------------------------------------------------------------
async function cleanup() {
  try { if (browser) await browser.close(); } catch (_e) {}
  try { await stopServer(srv); } catch (_e) {}
  try { if (mock) await new Promise((r) => mock.close(r)); } catch (_e) {}
  try { if (pool) await pool.end(); } catch (_e) {}
  try {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await c.end();
  } catch (_e) {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) {}
}

main()
  .catch((err) => {
    console.error('\n❌ verify:v25-live crashed:', err && err.stack ? err.stack.slice(0, 1200) : err);
    failed += 1;
  })
  .finally(async () => {
    await cleanup();
    process.exit(failed ? 1 : 0);
  });
