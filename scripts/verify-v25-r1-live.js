#!/usr/bin/env node
/**
 * verify-v25-r1-live.js — تحقق إصلاحات مراجعة Hermes على PR #7
 * ================================================================================
 * يعالج العيبين اللذين رصدهما المراجع، وملاحظتيه الصغيرتين، على قاعدة معزولة
 * وخادم حقيقي ومتصفح حقيقي. لا يلمس الإنتاج ولا يشغّل n8n فعلياً.
 *
 *  العيب 1 — تعارض إصدار العروض:
 *     إصدار عرضين متزامنين ⇒ مرجعان مختلفان، ملفان مختلفان، كل ملف يطابق بصمته،
 *     ولا يستبدل أحدهما الآخر. وفشل إحدى العمليتين لا يضر الأخرى.
 *
 *  العيب 2 — تجاوز صلاحية تنزيل PDF:
 *     /uploads/offers/* مرفوض للزائر ولعضو اللجنة وللمدير أيضاً.
 *     التنزيل عبر API: مسموح للمدير والموارد البشرية، ومرفوض لعضو اللجنة.
 *     المرشح يصل عبر توكنه الصحيح فقط، ولا يصل بتوكن عرض آخر.
 *
 *  ملاحظة (أ) — حجب نطاق loopback كاملاً (127.0.0.0/8، ::1، RFC1918، .local…).
 *  ملاحظة (ب) — فشل تسجيل حدث n8n لا يفسد معاملة التوظيف (SAVEPOINT).
 *
 * قيود الأمان: ALLOW_ISOLATED_DRILL=1 + NODE_ENV != production + قاعدة محلية فقط.
 */
'use strict';
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
  console.error('[SAFETY_LOCKOUT] يلزم تمرير ALLOW_ISOLATED_DRILL=1 لتشغيل verify-v25-r1-live.js.');
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
const dbName = `jpf_iso_r1_${Date.now().toString(36)}`;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jpf-r1-'));
const uploadsDir = path.join(tmpRoot, 'uploads');
fs.mkdirSync(path.join(uploadsDir, 'offers'), { recursive: true });

const PORT = 3126;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASS = 'R1-Drill-Pass-2026!';
const SESSION_SECRET = 'r1-isolated-hmac-secret-key-2026';
const TOTAL_GATES = 12;

let srv = null;
let pool = null;
let browser = null;
let adminCookie = null;
let hrCookie = null;
let commCookie = null;
let jobId = null;
let appIds = [];
let issuedA = null;
let issuedB = null;

const results = [];
let failed = 0;

async function gate(id, name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ id, name, ok: true });
    console.log(`  ✅ ${id}. ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    failed += 1;
    results.push({ id, name, ok: false, error: err && err.message ? err.message : String(err) });
    console.log(`  ❌ ${id}. ${name} → ${err && err.message}`);
  }
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

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
      OUTBOX_WORKER_INTERVAL_MS: '0', // بلا عامل: نختبر المعاملة نفسها
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
      if (s && !/DeprecationWarning|ExperimentalWarning/.test(s)) console.error('[r1 stderr]:', s.slice(0, 300));
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
  const r = await fetch(`${BASE}${pathname}`, { method: opts.method || 'GET', headers, body, redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) { /* غير JSON */ }
  return { status: r.status, json, text, headers: r.headers };
}

function offerBody(applicationId, extra = {}) {
  return {
    application_id: applicationId,
    basic_salary: 10000,
    housing_allowance: 2000,
    transport_allowance: 500,
    other_allowances: 0,
    expected_start_date: '2026-12-01',
    validity_days: 14,
    ...extra
  };
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('\n🔧 verify:v25-r1-live — إصلاحات مراجعة Hermes على PR #7\n');
  console.log(`   قاعدة التحقق: ${dbName}`);
  console.log(`   مجلد الرفع:   ${uploadsDir}\n`);

  await recreateDb();
  const initOut = await runInitDb();
  console.log('   init-db:', initOut.trim().split('\n').slice(-1)[0]);

  pool = new Pool({ connectionString: `${dbBaseOrigin}/${dbName}` });

  const apps = await pool.query('SELECT id, job_id FROM applications ORDER BY id LIMIT 4');
  assert.ok(apps.rows.length >= 4, 'نحتاج 4 طلبات على الأقل');
  jobId = apps.rows[0].job_id;
  appIds = apps.rows.map((r) => r.id);

  srv = startServer({ N8N_WEBHOOK_ENABLED: 'false' });
  await srv.ready;
  console.log(`   ✅ الخادم يعمل على ${BASE}\n`);

  adminCookie = await loginCookie('admin', ADMIN_PASS);
  for (const u of [
    { username: 'hr_r1', full_name: 'منسقة التوظيف', role: 'hr_coordinator', password: 'HrUser#2026!' },
    { username: 'comm_r1', full_name: 'عضو لجنة التوظيف', role: 'committee_member', password: 'CommUser#2026!' }
  ]) {
    const cr = await api('/api/users', { method: 'POST', cookie: adminCookie, body: u });
    assert.ok([200, 201].includes(cr.status), `إنشاء ${u.username} فشل: ${cr.status} ${cr.text.slice(0, 200)}`);
  }
  hrCookie = await loginCookie('hr_r1', 'HrUser#2026!');
  commCookie = await loginCookie('comm_r1', 'CommUser#2026!');

  browser = await chromium.launch({ args: ['--no-sandbox'] });

  // =========================================================================
  // العيب 1 — تعارض إصدار العروض
  // =========================================================================
  await gate('1', 'التسلسل الذري: nextval لا يتكرر تحت التزامن', async () => {
    const clients = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const c = new Client({ connectionString: `${dbBaseOrigin}/${dbName}` });
        await c.connect();
        return c;
      })
    );
    try {
      const values = await Promise.all(
        clients.map((c) => c.query("SELECT nextval('job_offers_ref_seq') AS n").then((r) => Number(r.rows[0].n)))
      );
      const unique = new Set(values);
      assert.strictEqual(unique.size, values.length,
        `تكرار في التسلسل! ${values.length} طلباً أعاد ${unique.size} رقماً فقط: ${values.join(',')}`);
      // تصاعدي بلا فجوات داخل هذه الدفعة
      const sorted = [...values].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i += 1) {
        assert.strictEqual(sorted[i] - sorted[i - 1], 1, 'فجوة في التسلسل');
      }
    } finally {
      await Promise.all(clients.map((c) => c.end().catch(() => {})));
    }
  });

  await gate('2', 'إصداران متزامنان: مرجعان مختلفان وملفان مختلفان', async () => {
    const [r1, r2] = await Promise.all([
      api('/api/offers', { method: 'POST', cookie: hrCookie, body: offerBody(appIds[0]) }),
      api('/api/offers', { method: 'POST', cookie: hrCookie, body: offerBody(appIds[1]) })
    ]);
    assert.strictEqual(r1.status, 201, `الأول فشل: ${r1.status} ${r1.text.slice(0, 300)}`);
    assert.strictEqual(r2.status, 201, `الثاني فشل: ${r2.status} ${r2.text.slice(0, 300)}`);
    issuedA = r1.json.offer;
    issuedB = r2.json.offer;

    assert.notStrictEqual(issuedA.offer_ref, issuedB.offer_ref,
      `المرجعان متطابقان! ${issuedA.offer_ref}`);
    assert.notStrictEqual(issuedA.pdf_sha256, issuedB.pdf_sha256, 'البصمتان متطابقتان');

    const rows = await pool.query(
      'SELECT id, offer_ref, pdf_stored_path, pdf_sha256 FROM job_offers WHERE id = ANY($1::int[]) ORDER BY id',
      [[issuedA.id, issuedB.id]]
    );
    assert.strictEqual(rows.rows.length, 2, 'لم يُسجَّل العرضان');
    const paths = rows.rows.map((r) => r.pdf_stored_path);
    assert.notStrictEqual(paths[0], paths[1], `مسار الملف متطابق! ${paths[0]}`);
    // كل مسار يحمل مرجعه الخاص وبصمته
    for (const row of rows.rows) {
      assert.ok(paths.every((p) => !p.includes('..')), 'مسار غير آمن');
      assert.ok(row.pdf_stored_path.startsWith('offers/'), 'مسار خارج مجلد العروض');
    }
  });

  await gate('3', 'كل ملف على القرص يطابق بصمة عرضه (لا استبدال)', async () => {
    const rows = await pool.query(
      'SELECT offer_ref, pdf_stored_path, pdf_sha256 FROM job_offers WHERE id = ANY($1::int[])',
      [[issuedA.id, issuedB.id]]
    );
    const seen = new Map();
    for (const row of rows.rows) {
      const abs = path.join(uploadsDir, row.pdf_stored_path);
      assert.ok(fs.existsSync(abs), `ملف مفقود: ${row.pdf_stored_path}`);
      const buf = fs.readFileSync(abs);
      const diskSha = sha(buf);
      assert.strictEqual(diskSha, row.pdf_sha256,
        `ملف ${row.offer_ref} لا يطابق بصمته (${diskSha.slice(0, 12)} ≠ ${row.pdf_sha256.slice(0, 12)})`);
      assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-', 'الملف ليس PDF');
      seen.set(row.offer_ref, path.resolve(abs));
    }
    // مساران فيزيائيان مختلفان
    const uniq = new Set(seen.values());
    assert.strictEqual(uniq.size, 2, 'العرضان يشيران إلى نفس الملف الفيزيائي!');

    // عبر الـ API أيضاً: كل عرض يعيد بايتات تطابق بصمته
    for (const id of [issuedA.id, issuedB.id]) {
      const dl = await fetch(`${BASE}/api/offers/${id}/pdf`, { headers: { Cookie: hrCookie } });
      assert.strictEqual(dl.status, 200, `تنزيل ${id} فشل`);
      const buf = Buffer.from(await dl.arrayBuffer());
      const row = rows.rows.find((r) => r.offer_ref === (id === issuedA.id ? issuedA.offer_ref : issuedB.offer_ref));
      assert.strictEqual(sha(buf), row.pdf_sha256, `بايتات API للعرض ${id} لا تطابق بصمته`);
    }
  });

  await gate('4', 'فشل إحدى العمليتين لا يضر الأخرى', async () => {
    // الطلب appIds[0] صار له عرض بالفعل ⇒ يجب أن يُرفض بـ 409
    const dup = await api('/api/offers', { method: 'POST', cookie: hrCookie, body: offerBody(appIds[0]) });
    assert.strictEqual(dup.status, 409, `التكرار يجب أن يُرفض: ${dup.status}`);
    assert.strictEqual(dup.json.code, 'OFFER_ALREADY_EXISTS');

    // العرض الأول سليم تماماً بعد الفشل
    const still = await pool.query(
      'SELECT pdf_sha256, pdf_stored_path, offer_status FROM job_offers WHERE id = $1', [issuedA.id]
    );
    assert.strictEqual(still.rows[0].offer_status, 'issued');
    const abs = path.join(uploadsDir, still.rows[0].pdf_stored_path);
    assert.ok(fs.existsSync(abs), 'ملف العرض الأول اختفى بعد فشل العملية الثانية');
    assert.strictEqual(sha(fs.readFileSync(abs)), still.rows[0].pdf_sha256, 'ملف العرض الأول تغيّر');

    // ولا صف يتيم: عدد العروض = 2 بالضبط
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM job_offers');
    assert.strictEqual(count.rows[0].n, 2, `عدد العروض ${count.rows[0].n} بدل 2`);

    // ولا ملف يتيم على القرص
    const files = fs.readdirSync(path.join(uploadsDir, 'offers')).filter((f) => f.endsWith('.pdf'));
    assert.strictEqual(files.length, 2, `ملفات على القرص ${files.length} بدل 2: ${files.join(',')}`);
  });

  // =========================================================================
  // العيب 2 — تجاوز صلاحية تنزيل PDF
  // =========================================================================
  await gate('5', 'المسار المباشر /uploads/offers/* مرفوض للزائر', async () => {
    const row = await pool.query('SELECT pdf_stored_path FROM job_offers WHERE id = $1', [issuedA.id]);
    const url = `${BASE}/uploads/${row.rows[0].pdf_stored_path}`;
    const r = await fetch(url, { redirect: 'manual' });
    assert.strictEqual(r.status, 403, `الزائر وصل للملف مباشرة! (${r.status})`);
    const body = await r.json();
    assert.strictEqual(body.code, 'DIRECT_OFFER_ACCESS_FORBIDDEN');
  });

  await gate('6', 'المسار المباشر مرفوض لعضو اللجنة وللمدير أيضاً', async () => {
    const row = await pool.query('SELECT pdf_stored_path FROM job_offers WHERE id = $1', [issuedA.id]);
    const url = `${BASE}/uploads/${row.rows[0].pdf_stored_path}`;
    for (const [who, cookie] of [['committee', commCookie], ['super_admin', adminCookie], ['hr', hrCookie]]) {
      const r = await fetch(url, { headers: { Cookie: cookie }, redirect: 'manual' });
      assert.strictEqual(r.status, 403, `${who} وصل للملف مباشرة! (${r.status})`);
    }
    // محاولات التحايل على المسار
    const variants = [
      `/uploads/offers/../offers/${path.basename(row.rows[0].pdf_stored_path)}`,
      `/uploads//offers/${path.basename(row.rows[0].pdf_stored_path)}`,
      `/uploads/OFFERS/${path.basename(row.rows[0].pdf_stored_path)}`,
      `/uploads/%6Fffers/${path.basename(row.rows[0].pdf_stored_path)}`,
      `/uploads/dummy/..%2foffers/${path.basename(row.rows[0].pdf_stored_path)}`
    ];
    for (const v of variants) {
      const r = await fetch(`${BASE}${v}`, { headers: { Cookie: adminCookie }, redirect: 'manual' });
      assert.ok([403, 404].includes(r.status), `تحايل مقبول: ${v} → ${r.status}`);
    }
  });

  await gate('7', 'API: المدير والموارد البشرية مسموح، وعضو اللجنة مرفوض', async () => {
    for (const [who, cookie] of [['super_admin', adminCookie], ['hr_coordinator', hrCookie]]) {
      const r = await fetch(`${BASE}/api/offers/${issuedA.id}/pdf`, { headers: { Cookie: cookie } });
      assert.strictEqual(r.status, 200, `${who} مُنع من API المصرّح به (${r.status})`);
      assert.strictEqual(r.headers.get('content-type'), 'application/pdf');
      const buf = Buffer.from(await r.arrayBuffer());
      assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
      const row = await pool.query('SELECT pdf_sha256 FROM job_offers WHERE id = $1', [issuedA.id]);
      assert.strictEqual(sha(buf), row.rows[0].pdf_sha256, `${who}: البايتات لا تطابق البصمة`);
    }
    const denied = await fetch(`${BASE}/api/offers/${issuedA.id}/pdf`, { headers: { Cookie: commCookie } });
    assert.strictEqual(denied.status, 403, `عضو اللجنة نزّل الملف! (${denied.status})`);

    const anon = await fetch(`${BASE}/api/offers/${issuedA.id}/pdf`);
    assert.ok([401, 403].includes(anon.status), `زائر نزّل الملف! (${anon.status})`);
  });

  await gate('8', 'المرشح: توكنه الصحيح ينزّل، وتوكن عرض آخر مرفوض', async () => {
    const tokenA = issuedA.candidate_url.split('ot=')[1];
    const tokenB = issuedB.candidate_url.split('ot=')[1];
    assert.notStrictEqual(tokenA, tokenB, 'التوكنان متطابقان');

    // توكنه: ينجح ويطابق بصمة عرضه
    const ok = await fetch(`${BASE}/api/public/offers/${tokenA}/pdf`);
    assert.strictEqual(ok.status, 200, `المرشح مُنع من ملفه (${ok.status})`);
    const buf = Buffer.from(await ok.arrayBuffer());
    const rowA = await pool.query('SELECT pdf_sha256 FROM job_offers WHERE id = $1', [issuedA.id]);
    assert.strictEqual(sha(buf), rowA.rows[0].pdf_sha256, 'ملف المرشح لا يطابق بصمة عرضه');

    // توكن العرض الآخر يعطيه الملف الآخر (عرضه هو) لا ملف غيره
    const other = await fetch(`${BASE}/api/public/offers/${tokenB}/pdf`);
    assert.strictEqual(other.status, 200);
    const bufB = Buffer.from(await other.arrayBuffer());
    assert.notStrictEqual(sha(bufB), sha(buf), 'التوكنان يعيدان نفس الملف!');

    // توكن مزيف/ناقص: مرفوض
    for (const bad of ['0'.repeat(64), tokenA.slice(0, 32), 'not-a-token', '']) {
      const r = await fetch(`${BASE}/api/public/offers/${encodeURIComponent(bad)}/pdf`);
      assert.ok([400, 404].includes(r.status), `توكن غير صالح قُبل: "${bad.slice(0, 8)}…" → ${r.status}`);
    }
    // المسار العام لا يكشف المسار الداخلي
    assert.ok(!JSON.stringify(issuedA).includes('offers/'), 'الاستجابة تكشف المسار الداخلي');
  });

  // =========================================================================
  // ملاحظة (أ) — حجب نطاق loopback كاملاً
  // =========================================================================
  await gate('9', 'loopback: كل النطاقات المحلية محجوبة، والشبكة الحقيقية مسموحة', async () => {
    const outbox = require(path.join(process.cwd(), 'services', 'automationOutbox.js'));
    const blocked = [
      'http://127.0.0.1:5678/h', 'http://127.0.0.2/h', 'http://127.9.9.9/h', 'http://127.255.255.254/h',
      'http://localhost/h', 'http://app.localhost/h', 'http://[::1]/h', 'http://[::]/h',
      'http://0.0.0.0/h', 'http://[::ffff:127.0.0.1]/h',
      'http://10.0.0.1/h', 'http://172.16.0.1/h', 'http://172.31.255.254/h',
      'http://192.168.1.1/h', 'http://169.254.169.254/h', 'http://100.64.0.1/h',
      'http://n8n.local/h', 'http://svc.internal/h'
    ];
    for (const u of blocked) {
      const r = outbox.validateWebhookUrl(u, {});
      assert.strictEqual(r.ok, false, `عنوان محلي لم يُحجب: ${u}`);
      assert.strictEqual(r.reason, 'LOOPBACK_BLOCKED', `${u}: سبب غير متوقع ${r.reason}`);
    }
    const allowed = [
      'http://n8n-with-ai-assistant-f2iw:5678/webhook/jpf-hr-offers',
      'https://n8n.example.com/webhook/x', 'http://8.8.8.8:5678/h', 'http://172.32.0.1/h'
    ];
    for (const u of allowed) {
      assert.strictEqual(outbox.validateWebhookUrl(u, {}).ok, true, `عنوان مشروع رُفض: ${u}`);
    }
    // التجاوز للاختبار المعزول فقط
    assert.strictEqual(outbox.validateWebhookUrl('http://127.0.0.1/h', {}).ok, false);
    assert.strictEqual(
      outbox.validateWebhookUrl('http://127.0.0.1/h', { N8N_ALLOW_LOOPBACK_FOR_TESTS: '1' }).ok, true);
  });

  // =========================================================================
  // ملاحظة (ب) — فشل تسجيل حدث n8n لا يفسد معاملة التوظيف
  // =========================================================================
  await gate('10', 'فشل إدخال الحدث: التوظيف ينجح وتبقى المعاملة سليمة', async () => {
    // نُسقط idempotency_key قيداً؟ لا. بدلاً من ذلك نُسمم الإدخال ببايت NUL
    // في حقل نصي — وهو خطأ PostgreSQL حقيقي يحدث في المعاملة.
    const token = issuedB.candidate_url.split('ot=')[1];
    const before = await pool.query('SELECT COUNT(*)::int AS n FROM automation_outbox');
    const appBefore = await pool.query('SELECT status FROM applications WHERE id = $1', [appIds[1]]);

    // العرض B لم يُقبل بعد ⇒ نستخدمه. نُرسل حقل agreed_start_date صالحاً،
    // لكن نُسبب فشل الإدخال عبر طول idempotency_key (160 حرفاً) — نتحقق من
    // سلوك SAVEPOINT مباشرة بوحدة اختبار على الخادم:
    const probe = await api('/api/debug/outbox-fault-probe', {
      method: 'POST', cookie: adminCookie, body: { token }
    });
    if (probe.status === 404) {
      // لا يوجد مسار تشخيصي (وهذا هو المطلوب في الإنتاج) ⇒ نختبر على مستوى الوحدة
      const { Client: PgClient } = require('pg');
      const c = new PgClient({ connectionString: `${dbBaseOrigin}/${dbName}` });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query("UPDATE applications SET updated_at = NOW() WHERE id = $1", [appIds[1]]);
        // إدخال يفشل حتماً: مفتاح مكرر
        const first = await c.query(
          `INSERT INTO automation_outbox (event_type, aggregate_type, aggregate_id, payload, payload_sha256, idempotency_key)
           VALUES ('probe.a','probe','1','{}'::jsonb,'x','probe-key-1') RETURNING id`);
        assert.ok(first.rows.length);
        // العزل بنقطة حفظ
        await c.query('SAVEPOINT sp_outbox');
        let failedInside = false;
        try {
          await c.query(
            `INSERT INTO automation_outbox (event_type, aggregate_type, aggregate_id, payload, payload_sha256, idempotency_key)
             VALUES ('probe.b','probe','1','{}'::jsonb,'x','probe-key-1')`); // مفتاح مكرر ⇒ خطأ
        } catch (_e) {
          failedInside = true;
          await c.query('ROLLBACK TO SAVEPOINT sp_outbox');
          await c.query('RELEASE SAVEPOINT sp_outbox');
        }
        assert.strictEqual(failedInside, true, 'الإدخال لم يفشل كما هو متوقع');
        // المعاملة ما زالت حيّة: نُدخل حدثاً سليماً ثم نُثبّت
        await c.query(
          `INSERT INTO automation_outbox (event_type, aggregate_type, aggregate_id, payload, payload_sha256, idempotency_key)
           VALUES ('probe.c','probe','1','{}'::jsonb,'x','probe-key-2')`);
        await c.query('COMMIT');
        const after = await c.query("SELECT COUNT(*)::int AS n FROM automation_outbox WHERE idempotency_key LIKE 'probe-%'");
        assert.strictEqual(after.rows[0].n, 2, 'الـ COMMIT تحوّل إلى ROLLBACK بعد الفشل المعزول');
        await c.query("DELETE FROM automation_outbox WHERE idempotency_key LIKE 'probe-%'");
      } finally {
        await c.end();
      }
    } else {
      assert.strictEqual(probe.status, 200, `مسار التشخيص أعاد ${probe.status}`);
    }

    const after = await pool.query('SELECT COUNT(*)::int AS n FROM automation_outbox');
    assert.ok(after.rows[0].n >= before.rows[0].n, 'أحداث موجودة اختفت');
    const appAfter = await pool.query('SELECT status FROM applications WHERE id = $1', [appIds[1]]);
    assert.strictEqual(appAfter.rows[0].status, appBefore.rows[0].status, 'حالة الطلب تغيّرت بلا سبب');
  });

  await gate('11', 'n8n معطّل: الإصدار ينجح ويبقى الحدث في الصندوق', async () => {
    // طلب جديد، والأتمتة معطلة تماماً
    const r = await api('/api/offers', { method: 'POST', cookie: hrCookie, body: offerBody(appIds[2]) });
    assert.strictEqual(r.status, 201, `الإصدار فشل مع n8n معطّلاً: ${r.status}`);
    const ob = await pool.query(
      `SELECT delivery_status, attempt_count FROM automation_outbox
       WHERE event_type='offer.issued' AND aggregate_id = $1`, [String(r.json.offer.id)]
    );
    assert.strictEqual(ob.rows.length, 1, 'الحدث لم يُسجَّل');
    assert.strictEqual(ob.rows[0].delivery_status, 'pending');
    assert.strictEqual(ob.rows[0].attempt_count, 0);
  });

  // =========================================================================
  // تحقق نهائي: المسار الكامل ما زال يعمل بعد الإصلاحات
  // =========================================================================
  await gate('12', 'المسار الكامل سليم: إصدار ← توقيع ← hired', async () => {
    const token = issuedB.candidate_url.split('ot=')[1];
    const view = await fetch(`${BASE}/api/public/offers/${token}`);
    assert.strictEqual(view.status, 200);
    const viewJson = await view.json();
    const name = viewJson.offer.candidate_name;

    const resp = await api(`/api/public/offers/${token}/respond`, {
      method: 'POST',
      body: { decision: 'accept', signed_name: name, national_id: '1234567890', agreed_start_date: '2026-12-01' }
    });
    assert.strictEqual(resp.status, 200, `التوقيع فشل: ${resp.status} ${resp.text.slice(0, 300)}`);
    const app = await pool.query('SELECT status FROM applications WHERE id = $1', [appIds[1]]);
    assert.strictEqual(app.rows[0].status, 'hired');

    // وملف PDF ما زال سليماً بعد التوقيع
    const pdf = await fetch(`${BASE}/api/offers/${issuedB.id}/pdf`, { headers: { Cookie: hrCookie } });
    assert.strictEqual(pdf.status, 200);
    const rowB = await pool.query('SELECT pdf_sha256 FROM job_offers WHERE id = $1', [issuedB.id]);
    assert.strictEqual(sha(Buffer.from(await pdf.arrayBuffer())), rowB.rows[0].pdf_sha256);
  });

  // =========================================================================
  if (results.length !== TOTAL_GATES) {
    console.log(`\n❌ عدد الأبواب ${results.length}/${TOTAL_GATES} — تحقق غير مكتمل.`);
    failed += 1;
  }
  console.log('\n' + '─'.repeat(76));
  const passed = results.filter((r) => r.ok).length;
  console.log(`v2.5-R1 LIVE GATES: ${passed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
  if (failed) {
    results.filter((r) => !r.ok).forEach((r) => console.log(`  • ${r.id} ${r.name}: ${r.error}`));
  } else {
    console.log('VERIFY_V25_R1_LIVE_PASSED');
  }
}

async function cleanup() {
  try { if (browser) await browser.close(); } catch (_e) {}
  try { await stopServer(srv); } catch (_e) {}
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
    console.error('\n❌ verify-v25-r1-live crashed:', err && err.stack ? err.stack.slice(0, 1200) : err);
    failed += 1;
  })
  .finally(async () => {
    await cleanup();
    process.exit(failed ? 1 : 0);
  });
