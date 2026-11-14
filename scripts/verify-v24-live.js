#!/usr/bin/env node
/**
 * verify-v24-live.js — تحقق قاعدة البيانات والـ HTTP الحقيقي لقاعات Jitsi (v2.4)
 * ---------------------------------------------------------------------------------
 * هذا الاختبار **لا** يعتمد على grep فقط: ينشئ قاعدة معزولة، يشغّل server.js فعلياً،
 * ويضرب المسارات الحقيقية عبر HTTP بأدوار الموظفين الثلاثة، ثم يتحقق من الأثر في القاعدة.
 *
 * ما يُثبته:
 *   - الترحيل التراكمي (db.js) يُنشئ أعمدة v2.4 على قاعدة قائمة بلا فقدان بيانات.
 *   - اسم الغرفة يُولَّد عند الجدولة ويُثبَّت ولا يتغيّر عند إعادة طلب الجلسة (UNIQUE).
 *   - المقابلة الحضورية تُرفض، والغرفة لا تُولَّد لها.
 *   - coordinator يستطيع فتح القاعة كـ participant فقط ولا يستطيع رصد تقييم.
 *   - committee_member يحصل على توكن moderator (JWT HS256) عند تفعيل السر.
 *   - telemetry: فتح/انضمام/إنهاء + المدة الفعلية تُحفظ في قاعدة البيانات فعلياً.
 *   - فشل DNS لا يكسر المنصة: /api/jitsi/status يرجع degraded + fallback.
 *
 * قيود أمان: ALLOW_ISOLATED_DRILL=1 + NODE_ENV != production + قاعدة محلية فقط + لا اتصال خارجي.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { Client, Pool } = require('pg');
const { chromium } = require('playwright');

if (process.env.ALLOW_ISOLATED_DRILL !== '1') {
  console.error('[SAFETY_LOCKOUT] يلزم تمرير ALLOW_ISOLATED_DRILL=1 لتشغيل verify-v24-live.js.');
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
const dbName = `jpf_iso_v24_${Date.now().toString(36)}`;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jpf-v24-'));
const uploadsDir = path.join(tmpRoot, 'uploads');
fs.mkdirSync(path.join(uploadsDir, 'public'), { recursive: true });

const PORT = 3124;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASS = 'V24-Drill-Pass-2026!';
const SESSION_SECRET = 'v24-isolated-hmac-secret-key-2026';
const JITSI_JWT_SECRET = 'v24-drill-jitsi-jwt-secret-not-real-0123456789';
const JITSI_DOMAIN = 'meet.drill.invalid';

// أرقام اصطناعية تولَّد وقت التشغيل — لا أرقام حقيقية في الملف
const stamp = String(Date.now()).slice(-7);
const DRILL_PHONE = `055${stamp}`;
const REMOTE_NAME = 'مرشح قاعة الاختبار';
const IN_PERSON_NAME = 'مرشح حضوري الاختبار';

let srv = null;
let pool = null;
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
  } finally {
    await c.end();
  }
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
  if (code !== 0) throw new Error(`init-db failed (${code}): ${out.slice(-800)}`);
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
      JITSI_ENABLED: 'true',
      JITSI_DOMAIN,
      JITSI_JWT_SECRET,
      JITSI_PROBE_TIMEOUT_MS: '800',
      ...extraEnv
    },
    stdio: 'pipe'
  });
  const capture = { stdout: '', stderr: '' };
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server start timeout')), 20000);
    proc.stdout.on('data', (d) => {
      capture.stdout += String(d);
      if (String(d).includes(String(PORT))) { clearTimeout(t); resolve(); }
    });
    proc.stderr.on('data', (d) => {
      capture.stderr += String(d);
      const s = String(d).trim();
      if (s) console.error('[v24 stderr]:', s);
    });
    proc.on('exit', (code) => {
      clearTimeout(t);
      if (code !== null && code !== 0) reject(new Error(`Server exited ${code}\n${capture.stderr.slice(-600)}`));
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

async function api(pathname, { method = 'GET', cookie, body } = {}) {
  const headers = { Cookie: cookie || '' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) { /* not json */ }
  return { status: r.status, json, text };
}

/** ينشئ مرشحاً وطلباً مقبولاً عبر واجهات API الحقيقية، ثم يعيد { applicationId, refNo } */
async function createCandidateApplication({ name, phone, email }) {
  const fd = new FormData();
  fd.append('job_id', '1');
  fd.append('full_name', name);
  fd.append('email', email);
  fd.append('phone', phone);
  fd.append('city', 'جدة');
  fd.append('years_experience', '3');
  fd.append('qualification', 'بكالوريوس');
  fd.append('specialization', 'تقنية معلومات');
  fd.append('privacy_consent', 'true');
  // سيرة اختبارية صغيرة تُولَّد وقت التشغيل (PDF بسيط) — لا بيانات حقيقية
  fd.append('cv_file', new Blob([Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>')], { type: 'application/pdf' }), 'drill-cv.pdf');
  const r = await fetch(`${BASE}/api/applications`, { method: 'POST', body: fd });
  const text = await r.text();
  assert.ok([200, 201].includes(r.status), `apply failed ${r.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const applicationId = json.application_id || json.applicationId || (json.application && json.application.id);
  const refNo = json.reference_no || json.referenceNo || (json.application && json.application.reference_no);
  assert.ok(applicationId, `apply did not return an application id: ${text.slice(0, 300)}`);
  return { applicationId, refNo };
}

async function setAppStatus(applicationId, status) {
  await pool.query('UPDATE applications SET status = $2 WHERE id = $1', [applicationId, status]);
}

async function scheduleInterview(applicationId, { date, mode = 'remote' } = {}) {
  return api('/api/interviews/schedule-single', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      application_id: applicationId,
      scheduled_date: date,
      start_time: '10:00',
      duration_minutes: 45,
      interview_mode: mode,
      interviewer_panel: 'لجنة التوظيف'
    }
  });
}

let adminCookie = null;
let hrCookie = null;
let commCookie = null;

function todayPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('\n🧪 verify:v24-live — قاعدة معزولة + HTTP حقيقي\n');

  await recreateDb();
  await runInitDb();
  srv = startServer();
  await srv.ready;
  pool = new Pool({ connectionString: `${dbBaseOrigin}/${dbName}` });
  pool.on('error', () => {});

  adminCookie = await loginCookie('admin', ADMIN_PASS);
  for (const u of [
    { username: 'hr_v24', full_name: 'منسقة الموارد البشرية', role: 'hr_coordinator', password: 'HrUser#2026!' },
    { username: 'comm_v24', full_name: 'عضو لجنة التوظيف', role: 'committee_member', password: 'CommUser#2026!' },
    { username: 'comm_v24_b', full_name: 'عضو لجنة ثانٍ', role: 'committee_member', password: 'CommB#2026!' }
  ]) {
    const cr = await api('/api/users', { method: 'POST', cookie: adminCookie, body: u });
    assert.strictEqual(cr.status, 201, `user create failed: ${cr.text.slice(0, 200)}`);
  }
  hrCookie = await loginCookie('hr_v24', 'HrUser#2026!');
  commCookie = await loginCookie('comm_v24', 'CommUser#2026!');

  // -------------------------------------------------------------------------
  await gate('1', 'migration: أعمدة v2.4 موجودة فعلياً في القاعدة', async () => {
    const cols = await pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'interviews'
         AND column_name IN ('jitsi_room_name','room_opened_by_staff_at','candidate_joined_room_at','actual_call_minutes')`
    );
    assert.strictEqual(cols.rows.length, 4, `expected 4 v2.4 columns, found ${cols.rows.length}`);
    const room = cols.rows.find((c) => c.column_name === 'jitsi_room_name');
    assert.strictEqual(room.is_nullable, 'YES', 'الغرفة تُملأ لاحقاً فلا تكون إلزامية');
    assert.strictEqual(room.data_type, 'character varying');
    const minutes = cols.rows.find((c) => c.column_name === 'actual_call_minutes');
    assert.strictEqual(minutes.data_type, 'integer');

    const idx = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'interviews' AND indexname = 'idx_interviews_jitsi_room_name'`
    );
    assert.strictEqual(idx.rows.length, 1, 'فهرس الغرفة الفريد مفقود');
    assert(/UNIQUE/i.test(idx.rows[0].indexdef), 'الفهرس يجب أن يكون UNIQUE');
  });

  // -------------------------------------------------------------------------
  const remote = await createCandidateApplication({
    name: REMOTE_NAME, phone: DRILL_PHONE, email: `v24.remote.${stamp}@example.test`
  });
  const inPerson = await createCandidateApplication({
    name: IN_PERSON_NAME, phone: `055${String(Number(stamp) + 11).slice(-7)}`, email: `v24.onsite.${stamp}@example.test`
  });
  await setAppStatus(remote.applicationId, 'passed_assessment');
  await setAppStatus(inPerson.applicationId, 'passed_assessment');

  const schRemote = await scheduleInterview(remote.applicationId, { date: todayPlus(2) });
  assert.ok([200, 201].includes(schRemote.status), `schedule remote failed: ${schRemote.status} ${schRemote.text.slice(0, 300)}`);
  const schInPerson = await scheduleInterview(inPerson.applicationId, { date: todayPlus(3), mode: 'in_person' });
  assert.ok([200, 201].includes(schInPerson.status), `schedule in-person failed: ${schInPerson.status} ${schInPerson.text.slice(0, 300)}`);

  const remoteRow = (await pool.query(
    `SELECT i.id, i.jitsi_room_name, i.meeting_url, i.interview_mode, i.visit_token
     FROM interviews i WHERE i.application_id = $1`, [remote.applicationId]
  )).rows[0];
  // رابط بطاقة الزيارة الموقّع (وليس رمز nonce الخام) — يُؤخذ من استجابة الجدولة الحقيقية
  const visitUrlFromApi = schRemote.json && schRemote.json.visit_url;
  assert.ok(visitUrlFromApi, 'الجدولة لم تُرجع رابط بطاقة زيارة موقّعاً');
  const inPersonRow = (await pool.query(
    `SELECT i.id, i.jitsi_room_name, i.interview_mode FROM interviews i WHERE i.application_id = $1`,
    [inPerson.applicationId]
  )).rows[0];

  await gate('2', 'scheduling: غرفة عشوائية تُثبَّت للمقابلة عن بُعد فقط', async () => {
    assert.ok(remoteRow, 'لم يُنشأ موعد للمرشح عن بُعد');
    assert.ok(/^jpf[a-f0-9]{28}$/.test(String(remoteRow.jitsi_room_name)), `اسم غرفة غير صالح: ${remoteRow.jitsi_room_name}`);
    assert.ok(String(remoteRow.meeting_url).includes(remoteRow.jitsi_room_name), 'رابط الاجتماع يجب أن يحمل نفس اسم الغرفة');
    assert.ok(String(remoteRow.meeting_url).startsWith(`https://${JITSI_DOMAIN}/`), 'رابط الاجتماع يجب أن يستخدم نطاق القاعة المهيّأ');
    assert.ok(!String(remoteRow.meeting_url).includes('meet.jit.si'), 'لا يجوز الرجوع لنطاق عام عند وجود غرفة خاصة');
    assert.strictEqual(inPersonRow.jitsi_room_name, null, 'المقابلة الحضورية لا يجب أن تحصل على غرفة');
    // لا تسريب هوية المرشح داخل اسم الغرفة
    assert.ok(!String(remoteRow.jitsi_room_name).includes(String(remote.refNo).slice(-4)), 'اسم الغرفة يجب ألا يشتق من رقم الطلب');
  });

  // -------------------------------------------------------------------------
  await gate('3', 'room-session: moderator للجنة، participant للمنسق، والغرفة ثابتة', async () => {
    const r1 = await api(`/api/interviews/${remoteRow.id}/room-session`, { cookie: commCookie });
    assert.strictEqual(r1.status, 200, `committee room-session failed: ${r1.status} ${r1.text.slice(0, 300)}`);
    const s1 = r1.json;
    assert.strictEqual(s1.room.role, 'moderator', 'عضو اللجنة يجب أن يدخل moderator');
    assert.strictEqual(s1.room.jwt_enabled, true, 'JWT يجب أن يكون مفعّلاً عند ضبط السر');
    assert.ok(s1.room.join_url.includes('#jwt='), 'توكن الإدارة يجب أن يُسلَّم في fragment');
    assert.strictEqual(s1.can_evaluate, true);
    assert.strictEqual(s1.candidate.full_name, REMOTE_NAME);
    assert.ok(s1.candidate.reference_no, 'ملف المرشح يجب أن يحمل الرقم المرجعي');
    // لا أسرار في الاستجابة
    assert.ok(!r1.text.includes(JITSI_JWT_SECRET), 'تسريب سر JWT في الاستجابة!');
    assert.ok(!r1.text.includes('password'), 'تسريب حقل كلمة مرور في الاستجابة!');
    assert.ok(!r1.text.includes(String(remoteRow.visit_token || 'x')), 'تسريب رمز الزيارة في جلسة القاعة!');

    const r2 = await api(`/api/interviews/${remoteRow.id}/room-session`, { cookie: hrCookie });
    assert.strictEqual(r2.status, 200, `coordinator room-session failed: ${r2.status}`);
    assert.strictEqual(r2.json.room.role, 'participant', 'المنسق يدخل participant لا moderator');
    assert.strictEqual(r2.json.can_evaluate, false, 'المنسق لا يملك صلاحية التقييم');
    assert.ok(!r2.text.includes('#jwt='), 'لا يجوز تسليم توكن إدارة للمنسق');

    // ثبات اسم الغرفة بين طلبين متتاليين
    const r3 = await api(`/api/interviews/${remoteRow.id}/room-session`, { cookie: commCookie });
    assert.strictEqual(r3.json.room.room_name, s1.room.room_name, 'اسم الغرفة تغيّر بين طلبين!');
    const dbRoom = (await pool.query('SELECT jitsi_room_name FROM interviews WHERE id = $1', [remoteRow.id])).rows[0];
    assert.strictEqual(dbRoom.jitsi_room_name, s1.room.room_name, 'الغرفة في القاعدة لا تطابق ما أُعيد للواجهة');
  });

  // -------------------------------------------------------------------------
  await gate('4', 'rbac: المنسق لا يستطيع رصد درجات اللجنة', async () => {
    const blocked = await api('/api/evaluations', {
      method: 'POST',
      cookie: hrCookie,
      body: {
        application_id: remote.applicationId,
        technical_competence: 5, communication_persuasion: 5, problem_solving: 5,
        cultural_fit: 5, portfolio_practical: 5, recommendation: 'hire'
      }
    });
    assert.strictEqual(blocked.status, 403, `المنسق يجب أن يُرفض (403) لكنه حصل على ${blocked.status}`);
    const before = await pool.query('SELECT COUNT(*)::int AS n FROM committee_evaluations WHERE application_id = $1', [remote.applicationId]);
    assert.strictEqual(before.rows[0].n, 0, 'لا يجوز أن يُسجَّل تقييم من المنسق');
  });

  // -------------------------------------------------------------------------
  await gate('5', 'telemetry: فتح/انضمام idempotent + مدة فعلية محفوظة', async () => {
    const open1 = await api(`/api/interviews/${remoteRow.id}/room-telemetry`, {
      method: 'POST', cookie: commCookie, body: { event: 'staff_opened' }
    });
    assert.strictEqual(open1.status, 200, `staff_opened failed: ${open1.text.slice(0, 200)}`);
    assert.ok(open1.json.session.room_opened_by_staff_at, 'وقت فتح القاعة لم يُسجَّل');

    const open2 = await api(`/api/interviews/${remoteRow.id}/room-telemetry`, {
      method: 'POST', cookie: commCookie, body: { event: 'staff_opened' }
    });
    assert.strictEqual(open2.json.idempotent, true, 'تكرار الحدث يجب أن يكون idempotent');
    assert.strictEqual(
      new Date(open2.json.session.room_opened_by_staff_at).toISOString(),
      new Date(open1.json.session.room_opened_by_staff_at).toISOString(),
      'الحدث المكرر غيّر وقت الفتح!'
    );

    const join = await api(`/api/interviews/${remoteRow.id}/room-telemetry`, {
      method: 'POST', cookie: commCookie, body: { event: 'candidate_joined' }
    });
    assert.strictEqual(join.status, 200);
    assert.ok(join.json.session.candidate_joined_room_at, 'وقت انضمام المرشح لم يُسجَّل');

    const bad = await api(`/api/interviews/${remoteRow.id}/room-telemetry`, {
      method: 'POST', cookie: commCookie, body: { event: 'drop_table' }
    });
    assert.strictEqual(bad.status, 400, 'الحدث غير المعروف يجب رفضه');

    const end = await api(`/api/interviews/${remoteRow.id}/room-telemetry`, {
      method: 'POST', cookie: commCookie, body: { event: 'call_ended' }
    });
    assert.strictEqual(end.status, 200, `call_ended failed: ${end.text.slice(0, 200)}`);
    assert.strictEqual(typeof end.json.session.actual_call_minutes, 'number', 'المدة لم تُحسب');

    // تحقق من الأثر الحقيقي في القاعدة
    const dbRow = (await pool.query(
      `SELECT room_opened_by_staff_at, candidate_joined_room_at, actual_call_minutes FROM interviews WHERE id = $1`,
      [remoteRow.id]
    )).rows[0];
    assert.ok(dbRow.room_opened_by_staff_at, 'وقت الفتح غير محفوظ في القاعدة');
    assert.ok(dbRow.candidate_joined_room_at, 'وقت الانضمام غير محفوظ في القاعدة');
    assert.ok(Number.isInteger(dbRow.actual_call_minutes), 'المدة غير محفوظة كعدد صحيح');

    // استمرارية المدة حتى بعد إعادة التشغيل (تُقرأ من القاعدة لا من الذاكرة)
    const readBack = await api(`/api/interviews/${remoteRow.id}/room-session`, { cookie: commCookie });
    assert.strictEqual(readBack.json.interview.actual_call_minutes, dbRow.actual_call_minutes, 'المدة لا تُقرأ من القاعدة');
  });

  // -------------------------------------------------------------------------
  await gate('6', 'guard: المقابلة الحضورية تُرفض في القاعة والقياس', async () => {
    const room = await api(`/api/interviews/${inPersonRow.id}/room-session`, { cookie: commCookie });
    assert.strictEqual(room.status, 400, `الحضوري يجب أن يُرفض، جاء ${room.status}`);
    assert.strictEqual(room.json.code, 'INTERVIEW_NOT_REMOTE');

    const tel = await api(`/api/interviews/${inPersonRow.id}/room-telemetry`, {
      method: 'POST', cookie: commCookie, body: { event: 'staff_opened' }
    });
    assert.strictEqual(tel.status, 400);
    assert.strictEqual(tel.json.code, 'INTERVIEW_NOT_REMOTE');
    const stillNull = (await pool.query('SELECT room_opened_by_staff_at FROM interviews WHERE id = $1', [inPersonRow.id])).rows[0];
    assert.strictEqual(stillNull.room_opened_by_staff_at, null, 'لا يجوز تسجيل أي قياس للحضوري');
  });

  // -------------------------------------------------------------------------
  await gate('7', 'status: فشل DNS لا يكسر المنصة ويرجع بديلاً', async () => {
    const st = await api('/api/jitsi/status', { cookie: hrCookie });
    assert.strictEqual(st.status, 200, `jitsi/status failed: ${st.status}`);
    assert.strictEqual(st.json.domain, JITSI_DOMAIN);
    assert.strictEqual(st.json.jwt_enabled, true);
    assert.strictEqual(st.json.degraded, true, `نطاق drill.invalid يجب ألا يُحل، جاء: ${JSON.stringify(st.json.probe)}`);
    assert.strictEqual(st.json.probe.status, 'NOT_RESOLVED');
    assert.ok(st.json.fallback_note, 'يجب توضيح البديل للمشرف');
    assert.ok(!st.text.includes(JITSI_JWT_SECRET), 'تسريب سر JWT في حالة القاعة!');
    // بقية المنصة تعمل رغم فشل النطاق
    const health = await api('/api/health');
    assert.strictEqual(health.status, 200, 'فشل DNS يجب ألا يُسقط /api/health');
  });

  // -------------------------------------------------------------------------
  await gate('8', 'visit-card: المرشح يحصل على القاعة برمز الزيارة فقط', async () => {
    // visit_url = صفحة Visit.dc.html?vt=<token>؛ نستخرج الرمز ونضرب نقطة الـ API الحقيقية
    const vt = new URL(visitUrlFromApi).searchParams.get('vt');
    assert.ok(vt, 'رابط بطاقة الزيارة لا يحمل رمز vt');
    const v = await fetch(`${BASE}/api/public/visit/${encodeURIComponent(vt)}`);
    const visitsStatus = v.status;
    const vRaw = await v.text();
    let vBody = null;
    try { vBody = JSON.parse(vRaw); } catch (_e) { throw new Error(`visit API did not return JSON: ${vRaw.slice(0, 160)}`); }
    assert.strictEqual(visitsStatus, 200, `visit card failed: ${visitsStatus} ${JSON.stringify(vBody).slice(0, 200)}`);
    assert.ok(vBody.interview.jitsi_room_url, 'بطاقة الزيارة يجب أن تحمل رابط القاعة');
    assert.ok(vBody.interview.jitsi_room_url.includes(remoteRow.jitsi_room_name), 'الرابط لا يطابق غرفة المقابلة');
    const vText = JSON.stringify(vBody);
    assert.ok(!vText.includes(JITSI_JWT_SECRET), 'تسريب سر JWT في بطاقة المرشح!');
    // عند تفعيل JWT: المرشح يحصل على توكن participant (ضروري لدخول Prosody) ولا يجوز أن يكون moderator
    const candUrl = vBody.interview.jitsi_room_url;
    if (candUrl.includes('#jwt=')) {
      const candToken = candUrl.split('#jwt=')[1].split('&')[0];
      const payload = JSON.parse(Buffer.from(candToken.split('.')[1], 'base64url').toString('utf8'));
      assert.strictEqual(payload.context.user.moderator, false, 'توكن المرشح يجب ألا يمنح صلاحية moderator');
      assert.strictEqual(payload.room, remoteRow.jitsi_room_name, 'توكن المرشح لغرفة أخرى!');
      assert.ok(payload.exp > Math.floor(Date.now() / 1000), 'توكن المرشح منتهي الصلاحية');
    }
    // وفي كل الأحوال: لا كلمة moderator في أي جزء من الاستجابة العامة
    assert.ok(!vText.includes('"moderator":true'), 'بطاقة المرشح تسرّب توكن إدارة');

    const badToken = await api('/api/public/visit/not-a-valid-token');
    assert.strictEqual(badToken.status, 403, 'رمز غير صالح يجب أن يُرفض');
  });

  // -------------------------------------------------------------------------
  await gate('9', 'privacy: لا بيانات مرشحين آخرين في جلسة القاعة', async () => {
    const a = await api(`/api/interviews/${remoteRow.id}/room-session`, { cookie: commCookie });
    assert.ok(!a.text.includes(IN_PERSON_NAME), 'جلسة القاعة تسرّب مرشحاً آخر');
    assert.ok(!a.text.includes(String(inPerson.refNo)), 'جلسة القاعة تسرّب رقم طلب مرشح آخر');
    // المنسق يرى نفس بيانات المقابلة الأساسية فقط، لا درجات اللجنة
    const b = await api(`/api/interviews/${remoteRow.id}/room-session`, { cookie: hrCookie });
    assert.ok(!('committee_avg_score' in (b.json.candidate || {})), 'لا يجوز كشف متوسط اللجنة في جلسة القاعة');
    assert.ok(!('ai_overall_score' in (b.json.candidate || {})), 'لا يجوز كشف درجة الذكاء الاصطناعي في جلسة القاعة');
  });

  // -------------------------------------------------------------------------
  await gate('10', 'restart: الغرفة والمدة تبقى بعد إعادة تشغيل الخادم', async () => {
    const before = await pool.query('SELECT jitsi_room_name, actual_call_minutes FROM interviews WHERE id = $1', [remoteRow.id]);
    await stopServer(srv);
    srv = startServer();
    await srv.ready;
    commCookie = await loginCookie('comm_v24', 'CommUser#2026!');
    const after = await api(`/api/interviews/${remoteRow.id}/room-session`, { cookie: commCookie });
    assert.strictEqual(after.status, 200, `room-session بعد إعادة التشغيل فشل: ${after.status}`);
    assert.strictEqual(after.json.room.room_name, before.rows[0].jitsi_room_name, 'الغرفة لم تصمد بعد إعادة التشغيل');
    assert.strictEqual(after.json.interview.actual_call_minutes, before.rows[0].actual_call_minutes, 'المدة لم تصمد بعد إعادة التشغيل');
  });

  // =========================================================================
  // اختبارات قبول إصلاحات مراجعة Hermes (R1) — مشكلة لكل بوابة
  // =========================================================================

  await gate('R1-1', 'المنسق لا يحصل على توكن إدارة من أي مسار (قائمة المواعيد)', async () => {
    // (أ) مسار قائمة المواعيد — هو مصدر التسريب الحقيقي الذي وجده Hermes
    const list = await api('/api/interviews', { cookie: hrCookie });
    assert.strictEqual(list.status, 200, `interviews list failed: ${list.status}`);
    const row = (list.json.interviews || []).find((i) => i.id === remoteRow.id);
    assert.ok(row, 'الموعد لا يظهر في قائمة المواعيد');
    assert.ok(row.jitsi_room_url, 'رابط القاعة مفقود من قائمة المواعيد');
    const hrUrl = row.jitsi_room_url;
    if (hrUrl.includes('#jwt=')) {
      const payload = JSON.parse(Buffer.from(hrUrl.split('#jwt=')[1].split('&')[0].split('.')[1], 'base64url').toString('utf8'));
      assert.strictEqual(payload.context.user.moderator, false, 'المنسق حصل على توكن moderator من قائمة المواعيد!');
    }
    assert.ok(!String(hrUrl).includes('"moderator":true'), 'تسريب توكن إدارة في قائمة المواعيد');

    // (ب) نفس الشيء للجنة — يجب أن تحصل على moderator
    const listComm = await api('/api/interviews', { cookie: commCookie });
    const rowComm = (listComm.json.interviews || []).find((i) => i.id === remoteRow.id);
    assert.ok(rowComm && rowComm.jitsi_room_url, 'قائمة المواعيد لا تعطي اللجنة رابطاً');
    if (rowComm.jitsi_room_url.includes('#jwt=')) {
      const p2 = JSON.parse(Buffer.from(rowComm.jitsi_room_url.split('#jwt=')[1].split('&')[0].split('.')[1], 'base64url').toString('utf8'));
      assert.strictEqual(p2.context.user.moderator, true, 'اللجنة يجب أن تحصل على moderator');
    }

    // (ج) وجميع مسارات القاعة معاً: ثلاثة أدوار، لا moderator إلا للجنة والإدارة
    const roles = [
      { name: 'hr_coordinator', cookie: hrCookie, expectModerator: false },
      { name: 'committee_member', cookie: commCookie, expectModerator: true }
    ];
    for (const r of roles) {
      const sess = await api(`/api/interviews/${remoteRow.id}/room-session`, { cookie: r.cookie });
      assert.strictEqual(sess.status, 200);
      const isMod = sess.json.room.role === 'moderator';
      assert.strictEqual(isMod, r.expectModerator, `${r.name}: صلاحية الغرفة ${sess.json.room.role} غير متوقعة`);
    }
  });

  await gate('R1-2', 'التقييم المحفوظ لا يُستبدل بقيم افتراضية', async () => {
    // نُعطي العضو تقييماً محفوظاً بقيم محددة، ثم نتأكد أن الواجهة تُعيدها كما هي
    await api('/api/evaluations', {
      method: 'POST', cookie: commCookie,
      body: {
        application_id: remote.applicationId,
        technical_competence: 4.5, communication_persuasion: 2, problem_solving: 5,
        cultural_fit: 1.5, portfolio_practical: 3.5,
        recommendation: 'hold', notes: 'تقييم محفوظ مسبقاً', voice_human_note: 'نبرة هادئة'
      }
    });
    const sess = await api(`/api/interviews/${remoteRow.id}/room-session`, { cookie: commCookie });
    assert.strictEqual(sess.status, 200);
    const mine = sess.json.my_evaluation;
    assert.ok(mine, 'التقييم المحفوظ لا يُعاد للواجهة — سيُستبدل بقيم افتراضية');
    assert.strictEqual(mine.technical_competence, 4.5);
    assert.strictEqual(mine.communication_persuasion, 2);
    assert.strictEqual(mine.problem_solving, 5);
    assert.strictEqual(mine.cultural_fit, 1.5);
    assert.strictEqual(mine.portfolio_practical, 3.5);
    assert.strictEqual(mine.recommendation, 'hold');
    assert.strictEqual(mine.notes, 'تقييم محفوظ مسبقاً');
    assert.strictEqual(mine.voice_human_note, 'نبرة هادئة');

    // ويجب أن يكون تقييم العضو نفسه لا تقييم غيره: عضو آخر يرى null
    const otherComm = await loginCookie('comm_v24_b', 'CommB#2026!');
    const otherSess = await api(`/api/interviews/${remoteRow.id}/room-session`, { cookie: otherComm });
    assert.strictEqual(otherSess.json.my_evaluation, null, 'عضو لجنة آخر يرى تقييماً ليس له!');

    // القيم في القاعدة لم تتغيّر بمجرد الفتح
    const dbEval = (await pool.query(
      'SELECT technical_competence, recommendation FROM committee_evaluations WHERE application_id = $1',
      [remote.applicationId]
    )).rows;
    assert.strictEqual(dbEval.length, 1);
    assert.strictEqual(Number(dbEval[0].technical_competence), 4.5, 'فتح القاعة غيّر التقييم المحفوظ');
  });

  await gate('R1-3', 'خيار الرفض يُحفظ فعلياً ولا يُسقط التقييم', async () => {
    // (أ) القيمة القديمة التي كانت تُسقط الطلب بـ 500
    const legacy = await api('/api/evaluations', {
      method: 'POST', cookie: commCookie,
      body: {
        application_id: remote.applicationId,
        technical_competence: 4, communication_persuasion: 4, problem_solving: 4,
        cultural_fit: 4, portfolio_practical: 4, recommendation: 'reject'
      }
    });
    assert.strictEqual(legacy.status, 400, `قيمة retired يجب أن تُرفض بـ 400 لا 500، جاء ${legacy.status}`);
    assert.strictEqual(legacy.json.code, 'INVALID_RECOMMENDATION');
    assert.ok(Array.isArray(legacy.json.allowed) && legacy.json.allowed.includes('no_hire'), 'الاستجابة لا توضح القيم المسموحة');

    // (ب) قيمة الرفض الصحيحة تُحفظ
    const ok = await api('/api/evaluations', {
      method: 'POST', cookie: commCookie,
      body: {
        application_id: remote.applicationId,
        technical_competence: 1, communication_persuasion: 1.5, problem_solving: 1,
        cultural_fit: 2, portfolio_practical: 1.5, recommendation: 'no_hire', notes: 'رفض'
      }
    });
    assert.ok([200, 201].includes(ok.status), `رفض مشروع لم يُحفظ: ${ok.status} ${ok.text.slice(0, 200)}`);
    const saved = (await pool.query(
      'SELECT recommendation, technical_competence FROM committee_evaluations WHERE application_id = $1',
      [remote.applicationId]
    )).rows[0];
    assert.strictEqual(saved.recommendation, 'no_hire', 'خيار الرفض لم يُحفظ في القاعدة');
    assert.strictEqual(Number(saved.technical_competence), 1, 'الدرجات لم تُحفظ مع الرفض');

    // (ج) الواجهة لا تحتوي على قيمة مرفوضة من القاعدة
    const page = await (await fetch(`${BASE}/InterviewRoom.dc.html`)).text();
    assert.ok(!page.includes('value="reject"'), 'الواجهة ما زالت ترسل قيمة reject غير المقبولة');
    assert.ok(page.includes('value="no_hire"'), 'الواجهة لا تعرض خيار الرفض بالقيمة الصحيحة');

    // تنظيف كي تبقى البوابات اللاحقة مستقلة
    await pool.query('DELETE FROM committee_evaluations WHERE application_id = $1', [remote.applicationId]);
  });

  // -------------------------------------------------------------------------
  await gate('10b', 'review payload: أسئلة AI + مشغل صوت + ملاحظة شفهية محفوظة', async () => {
    // نُثبّت أسئلة وظيفة على الطلب، ونسجّل تسجيلاً صوتياً وهمياً للمرشح
    const questions = ['اشرح أكبر تحدٍّ تقني واجهته.', 'كيف تتعامل مع ضغط المواعيد المتزامنة؟', 'ما أدواتك المفضلة للمراقبة؟'];
    const jobId = (await pool.query('SELECT job_id FROM applications WHERE id = $1', [remote.applicationId])).rows[0].job_id;
    await pool.query('UPDATE jobs SET questions = $2::jsonb WHERE id = $1', [jobId, JSON.stringify(questions)]);
    await pool.query(
      `UPDATE applications SET voice_pitch_path = $2, voice_mime_type = 'audio/webm', voice_retention_expires_at = NOW() + INTERVAL '20 days' WHERE id = $1`,
      [remote.applicationId, 'drill/voice-pitch.webm']
    );

    const r = await api(`/api/interviews/${remoteRow.id}/room-session`, { cookie: commCookie });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ai_questions.length, 3, 'أسئلة الـ AI لا تُعاد لعضو اللجنة');
    assert.strictEqual(r.json.ai_questions[0], questions[0], 'الأسئلة لا تطابق أسئلة الوظيفة');
    assert.strictEqual(r.json.voice_pitch.available, true, 'التسجيل الصوتي المتاح يجب أن يظهر في القاعة');
    assert.ok(String(r.json.voice_pitch.stream_url).includes(`/api/applications/${remote.applicationId}/voice-stream`), 'مسار الصوت المحمي غير مربوط');
    assert.ok(!r.text.includes('voice_pitch_path'), 'لا يجوز كشف مسار التخزين الداخلي للصوت');

    // انتهاء الاستبقاء ⇒ لا مشغل ولا رابط
    await pool.query(`UPDATE applications SET voice_retention_expires_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [remote.applicationId]);
    const expired = await api(`/api/interviews/${remoteRow.id}/room-session`, { cookie: commCookie });
    assert.strictEqual(expired.json.voice_pitch.available, false, 'التسجيل المنتهي استبقاؤه يجب ألا يُعرض');
    assert.strictEqual(expired.json.voice_pitch.stream_url, null, 'لا يجوز إرجاع رابط لتسجيل منتهي');
    await pool.query(`UPDATE applications SET voice_retention_expires_at = NOW() + INTERVAL '20 days' WHERE id = $1`, [remote.applicationId]);

    // الملاحظة الشفهية البشرية تُحفظ مع التقييم
    const ev = await api('/api/evaluations', {
      method: 'POST', cookie: commCookie,
      body: {
        application_id: remote.applicationId,
        technical_competence: 4, communication_persuasion: 4.5, problem_solving: 4,
        cultural_fit: 4, portfolio_practical: 4.5, recommendation: 'hire',
        notes: 'مقابلة قوية', voice_human_note: 'نبرة واثقة وإجابة منظمة'
      }
    });
    assert.ok([200, 201].includes(ev.status), `evaluation failed: ${ev.status} ${ev.text.slice(0, 200)}`);
    const saved = await pool.query('SELECT voice_human_note FROM committee_evaluations WHERE application_id = $1', [remote.applicationId]);
    assert.strictEqual(saved.rows[0].voice_human_note, 'نبرة واثقة وإجابة منظمة', 'الملاحظة الشفهية لم تُحفظ');
    // إعادة الحفظ بلا ملاحظة لا تمحو الملاحظة السابقة
    await api('/api/evaluations', {
      method: 'POST', cookie: commCookie,
      body: {
        application_id: remote.applicationId,
        technical_competence: 4, communication_persuasion: 4.5, problem_solving: 4,
        cultural_fit: 4, portfolio_practical: 4.5, recommendation: 'hire', notes: 'تحديث'
      }
    });
    const kept = await pool.query('SELECT voice_human_note FROM committee_evaluations WHERE application_id = $1', [remote.applicationId]);
    assert.strictEqual(kept.rows[0].voice_human_note, 'نبرة واثقة وإجابة منظمة', 'تحديث التقييم محا الملاحظة الشفهية');
    // نُصفّر التقييم كي تبقى بوابة المتصفح مستقلة في تحققها
    await pool.query('DELETE FROM committee_evaluations WHERE application_id = $1', [remote.applicationId]);
  });

  // -------------------------------------------------------------------------
  await gate('11', 'browser E2E (نطاق غير جاهز): بديل آمن مع بقاء التقييم قابلاً للحفظ', async () => {
    const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { Cookie: commCookie } });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/InterviewRoom.dc.html?interview_id=${remoteRow.id}`, { waitUntil: 'domcontentloaded' });
      // لا iframe إطلاقاً، بل لافتة تدهور ورابط بديل
      await page.waitForSelector('#jitsi-degraded-banner', { state: 'visible', timeout: 15000 });
      assert.strictEqual(await page.$$eval('[data-testid="jitsi-frame"]', (n) => n.length), 0, 'لا يجوز تضمين قاعة على نطاق غير جاهز');
      const bannerText = await page.textContent('#jitsi-degraded-banner');
      assert.ok(bannerText.includes('غير جاهز'), 'لافتة التدهور لا توضح السبب');
      // الالتزام الأهم: فشل القاعة لا يعطّل التقييم
      const bodyText = await page.textContent('body');
      assert.ok(bodyText.includes(REMOTE_NAME), 'ملف المرشح يجب أن يبقى متاحاً حتى مع تعذّر القاعة');
      // التوصية إلزامية الآن (منع تسجيل 'hire' افتراضي لم يقصده العضو)
      await page.selectOption('#eval-recommendation', 'hire');
      await page.click('[data-testid="save-eval"]');
      await page.waitForTimeout(1200);
      const n = (await pool.query('SELECT COUNT(*)::int AS n FROM committee_evaluations WHERE application_id = $1', [remote.applicationId])).rows[0].n;
      assert.strictEqual(n, 1, 'التقييم يجب أن يُحفظ حتى لو تعذّرت القاعة');
      await ctx.close();
    } finally {
      await browser.close();
    }
  });

  // نُعيد التشغيل بنطاق قابل للحل لاختبار المسار الكامل للشاشة المقسّمة
  await stopServer(srv);
  srv = startServer({ JITSI_DOMAIN: 'localhost' });
  await srv.ready;
  commCookie = await loginCookie('comm_v24', 'CommUser#2026!');
  hrCookie = await loginCookie('hr_v24', 'HrUser#2026!');

  // -------------------------------------------------------------------------
  await gate('12', 'browser E2E: الشاشة المقسّمة تعمل فعلياً (فيديو + ملف + تقييم)', async () => {
    // عزل: البوابة 11 حفظت تقييماً — نمسحه كي تقيس هذه البوابة أثرها وحدها
    await pool.query('DELETE FROM committee_evaluations WHERE application_id = $1', [remote.applicationId]);
    const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        extraHTTPHeaders: { Cookie: commCookie }
      });
      await ctx.route('https://localhost/**', (route) => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><body style="background:#0b0c0e;color:#fff;font-family:sans-serif">JITSI-DRILL-STUB</body></html>'
      }));
      const page = await ctx.newPage();
      const consoleErrors = [];
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
      page.on('pageerror', (e) => consoleErrors.push(String(e.message)));

      await page.goto(`${BASE}/InterviewRoom.dc.html?interview_id=${remoteRow.id}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="jitsi-frame"]', { timeout: 15000 });

      // (أ) القاعة مضمّنة فعلاً في الصفحة
      const frameSrc = await page.getAttribute('[data-testid="jitsi-frame"]', 'src');
      assert.ok(frameSrc && frameSrc.includes(remoteRow.jitsi_room_name), `الـ iframe لا يحمل غرفة المقابلة: ${frameSrc}`);

      // (ب) الشاشة المقسّمة: القاعة يمين ولوحة المرشح يسار في نفس الصف
      const layout = await page.evaluate(() => {
        const stage = document.querySelector('[data-testid="room-stage"]').getBoundingClientRect();
        const side = document.querySelector('.room-side').getBoundingClientRect();
        return { stageLeft: stage.left, stageRight: stage.right, sideLeft: side.left, sideRight: side.right, stageW: stage.width, sideW: side.width };
      });
      assert.ok(layout.sideRight <= layout.stageLeft + 2, `لوحة المرشح ليست يسار القاعة (RTL): side.right=${layout.sideRight} stage.left=${layout.stageLeft}`);
      assert.ok(layout.stageW > layout.sideW, 'القاعة يجب أن تكون الأوسع في التخطيط المقسّم');

      // (ج) ملف المرشح وبياناته تظهر بجانب الفيديو
      const metaName = await page.textContent('#meta-candidate');
      assert.strictEqual(metaName.trim(), REMOTE_NAME, 'اسم المرشح لا يظهر في الشريط العلوي');
      const bodyText = await page.textContent('body');
      assert.ok(bodyText.includes(String(remote.refNo)), 'الرقم المرجعي للمرشح لا يظهر بجانب القاعة');

      // (ج2) أسئلة الـ AI ومشغل الصوت ظاهران بجانب الفيديو
      const questionsVisible = await page.isVisible('#ai-questions-card');
      assert.strictEqual(questionsVisible, true, 'بطاقة أسئلة المقابلة لا تظهر في القاعة');
      const qCount = await page.$$eval('#ai-questions-list li', (n) => n.length);
      assert.strictEqual(qCount, 3, `عدد الأسئلة المعروضة ${qCount} بدل 3`);
      const voiceVisible = await page.isVisible('#voice-review-card');
      assert.strictEqual(voiceVisible, true, 'مشغل التسجيل الصوتي لا يظهر في القاعة');
      const audioSrc = await page.getAttribute('#voice-player', 'src');
      assert.ok(String(audioSrc).includes('voice-stream'), 'مشغل الصوت لا يشير للمسار المحمي');

      // (د) منزلقات التقييم الخمسة موجودة وقابلة للتحريك
      const sliders = await page.$$('input[data-score-key]');
      assert.strictEqual(sliders.length, 5, `عدد منزلقات التقييم ${sliders.length} بدل 5`);
      await page.$eval('input[data-score-key="technical_competence"]', (el) => {
        el.value = '5';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const shown = await page.textContent('[data-score-out="technical_competence"]');
      assert.strictEqual(shown, '5.0', 'قيمة المنزلق لا تتحدّث في الواجهة');

      // (هـ) الحفظ من داخل القاعة ينشئ تقييم اللجنة فعلياً في القاعدة
      if (await page.isVisible('#voice-human-note')) {
        await page.fill('#voice-human-note', 'ملاحظة من داخل القاعة');
      }

      // سلوك مقصود: الحفظ بلا توصية يجب أن يُمنع (لا 'hire' افتراضي)
      await page.click('[data-testid="save-eval"]');
      await page.waitForTimeout(600);
      const blocked = (await pool.query('SELECT COUNT(*)::int AS n FROM committee_evaluations WHERE application_id = $1', [remote.applicationId])).rows[0].n;
      assert.strictEqual(blocked, 0, 'تم حفظ تقييم بلا اختيار توصية صريحة');

      await page.selectOption('#eval-recommendation', 'no_hire');
      await page.click('[data-testid="save-eval"]');
      await page.waitForTimeout(1200);
      const noteRow = await pool.query('SELECT voice_human_note FROM committee_evaluations WHERE application_id = $1', [remote.applicationId]);
      if (noteRow.rows.length) {
        assert.strictEqual(noteRow.rows[0].voice_human_note, 'ملاحظة من داخل القاعة', 'الملاحظة الشفهية لم تُحفظ من الواجهة');
      }
      const evalRow = await pool.query(
        `SELECT technical_competence, evaluator_name, recommendation, voice_human_note FROM committee_evaluations WHERE application_id = $1`,
        [remote.applicationId]
      );
      assert.strictEqual(evalRow.rows.length, 1, 'التقييم لم يُحفظ من داخل القاعة');
      assert.strictEqual(Number(evalRow.rows[0].technical_competence), 5, 'درجة الكفاءة الفنية لم تُحفظ بالقيمة المرصودة');
      assert.strictEqual(evalRow.rows[0].recommendation, 'no_hire', 'خيار الرفض المختار من الواجهة لم يُحفظ');

      // (و) إنهاء المكالمة يوثّق المدة عبر الواجهة نفسها
      await page.click('#btn-end-call');
      await page.waitForTimeout(1200);
      const dur = (await pool.query('SELECT actual_call_minutes FROM interviews WHERE id = $1', [remoteRow.id])).rows[0];
      assert.ok(Number.isInteger(dur.actual_call_minutes), 'مدة المكالمة لم تُوثَّق من زر الإنهاء');

      // (ز) لا أخطاء JS في وحدة التحكم (عدا طلبات الشبكة المحجوبة للمحاكي)
      const realErrors = consoleErrors.filter((t) => !/Failed to load resource|net::ERR/i.test(t));
      assert.strictEqual(realErrors.length, 0, `أخطاء JS في صفحة القاعة: ${realErrors.slice(0, 3).join(' | ')}`);

      await ctx.close();
    } finally {
      await browser.close();
    }
  });

  // -------------------------------------------------------------------------
  await gate('13', 'browser E2E: المنسق يرى القاعة بلا صلاحية تقييم', async () => {
    const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, extraHTTPHeaders: { Cookie: hrCookie } });
      await ctx.route('https://localhost/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>stub</body></html>' }));
      const page = await ctx.newPage();
      await page.goto(`${BASE}/InterviewRoom.dc.html?interview_id=${remoteRow.id}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="jitsi-frame"]', { timeout: 15000 });
      const disabled = await page.$eval('[data-testid="save-eval"]', (el) => el.disabled);
      assert.strictEqual(disabled, true, 'زر الحفظ يجب أن يكون معطّلاً للمنسق');
      const hint = await page.textContent('#eval-hint');
      assert.ok(hint.includes('تنسيقي'), 'يجب توضيح أن الدخول تنسيقي بلا درجات');
      await ctx.close();
    } finally {
      await browser.close();
    }
  });

  // ---------------------------------------------------------------------------
  console.log('\n' + '─'.repeat(72));
  const passed = results.filter((r) => r.ok).length;
  console.log(`v2.4 LIVE GATES: ${passed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
  if (failed) {
    results.filter((r) => !r.ok).forEach((r) => console.log(`  • ${r.id} ${r.name}: ${r.error}`));
    process.exitCode = 1;
  } else {
    console.log('VERIFY_V24_LIVE_PASSED');
  }
}

async function cleanup() {
  try { await stopServer(srv); } catch (_e) {}
  try { if (pool) await pool.end(); } catch (_e) {}
  try {
    const c = new Client({ connectionString: adminUrl.toString() });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await c.end();
  } catch (_e) {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) {}
}

main()
  .catch((err) => {
    console.error('\nverify:v24-live crashed:', err && err.stack ? err.stack : err);
    if (srv && srv.capture) console.error('server stderr tail:', srv.capture.stderr.slice(-1200));
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    if (process.exitCode === undefined) process.exitCode = 0;
  });
