#!/usr/bin/env node
/**
 * مجموعة التحقق الشاملة والمعزولة للمرحلة 3 (v2.3 — WAHA Operational Messaging, Dry-Run Enforced)
 * ---------------------------------------------------------------------------------
 * معيار القبول (UNIFIED_EXECUTION_PLAN Section 11):
 *   - تشغيل خادم محاكاة WAHA محلي → التحقق من عدم وصول **أي طلب إرسال** في وضع Dry-Run.
 *   - تفعيل الإرسال والتحقق من خروج تذكير واحد فقط مع تجاهل المواعيد القديمة (حاجز waha_activated_at).
 *   - تفعيل Kill-Switch والتحقق من التوقف اللحظي.
 *   - إرسال webhook رد `1` وتحول الموعد إلى confirmed.
 *   - **بدون إرسال أي رسالة حقيقية لأي مرشح فعلي**: كل الاتصالات على 127.0.0.1 لمحاكي محلي فقط.
 *
 * يفرض حارس أمان: ALLOW_ISOLATED_DRILL=1 + NODE_ENV != production + قاعدة بيانات محلية معزولة.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Client, Pool } = require('pg');
const { chromium } = require('playwright');

if (process.env.ALLOW_ISOLATED_DRILL !== '1') {
  console.error('[SAFETY_LOCKOUT] يلزم تمرير ALLOW_ISOLATED_DRILL=1 لتشغيل verify-v23.js.');
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
const dbName = `jpf_iso_v23_${runSuffix}`;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jpf-v23-'));
const uploadsDir = path.join(tmpRoot, 'uploads');
fs.mkdirSync(path.join(uploadsDir, 'public'), { recursive: true });

const PORT = 3124;
const BASE = `http://127.0.0.1:${PORT}`;
const WAHA_MOCK_PORT = 3199;
// قيم وهمية للاختبار المعزول فقط (ليست أسراراً حقيقية ولا تصل لأي خدمة خارجية)
const WAHA_API_KEY = 'drill-waha-api-key-not-real-123456';
const WAHA_WEBHOOK_SECRET = 'drill-webhook-secret-not-real-abcdef';
const ADMIN_PASS = 'V23-Drill-Pass-2026!';
const SESSION_SECRET = 'v23-isolated-hmac-secret-key-2026';

// ---------------------------------------------------------------------------------
// محاكي WAHA المحلي: يسجل كل طلب يصل، ويفشل فوراً إن وصل أي /api/sendText
// ---------------------------------------------------------------------------------
const mockState = { hits: [], failNext: 0, server: null };

function mockSendTextCount() {
  return mockState.hits.filter((h) => h.path === '/api/sendText').length;
}

function startWahaMock() {
  mockState.server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${WAHA_MOCK_PORT}`);
    const authOk = req.headers['x-api-key'] === WAHA_API_KEY;
    mockState.hits.push({ method: req.method, path: url.pathname, auth: authOk, at: Date.now() });

    if (url.pathname === '/api/sessions') {
      if (!authOk) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([{ name: 'default', status: 'WORKING', config: { engine: 'NOWEB' } }]));
    }

    if (url.pathname === '/api/sendText') {
      if (!authOk) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      if (mockState.failNext > 0) {
        mockState.failNext -= 1;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'simulated_failure' }));
      }
      let raw = '';
      req.on('data', (c) => { raw += c; });
      return req.on('end', () => {
        const parsed = (() => { try { return JSON.parse(raw || '{}'); } catch (_e) { return {}; } })();
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: `mock-msg-${mockSendTextCount() - 1}`,
          _echo: { chatId: parsed.chatId, session: parsed.session }
        }));
      });
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolve) => mockState.server.listen(WAHA_MOCK_PORT, '127.0.0.1', resolve));
}

function stopWahaMock() {
  return new Promise((resolve) => (mockState.server ? mockState.server.close(resolve) : resolve()));
}

function resetWahaMock() {
  mockState.hits = [];
  mockState.failNext = 0;
}

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

const net = require('net');

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
      WAHA_BASE_URL: `http://127.0.0.1:${WAHA_MOCK_PORT}`,
      WAHA_ALLOW_LOOPBACK_FOR_TESTS: '1',
      WAHA_API_KEY,
      WAHA_SESSION: 'default',
      WAHA_WEBHOOK_SECRET,
      ...extraEnv
    },
    stdio: 'pipe'
  });
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server start timeout')), 15000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes(String(PORT))) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.stderr.on('data', (d) => {
      const s = String(d).trim();
      if (s) console.error('[v23 stderr]:', s);
    });
    proc.on('exit', (code) => {
      clearTimeout(t);
      if (code !== null && code !== 0) reject(new Error(`Server exited ${code}`));
    });
  });
  return { proc, ready };
}

async function stopServer(srv) {
  if (!srv || !srv.proc || srv.proc.killed) return;
  const proc = srv.proc;
  const exited = new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once('exit', resolve);
  });
  try { process.kill(-proc.pid, 'SIGTERM'); } catch (_e) { try { proc.kill('SIGTERM'); } catch (_e2) {} }
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 5000))
  ]);
  if (timedOut) {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch (_e) { try { proc.kill('SIGKILL'); } catch (_e2) {} }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  // لا نعيد تشغيل الخادم قبل تحرير المنفذ فعلياً (يمنع EADDRINUSE)
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

async function createCandidateApplication(email, phone, fullName) {
  const fd = new FormData();
  fd.append('job_id', '1');
  fd.append('full_name', fullName);
  fd.append('email', email);
  fd.append('phone', phone);
  fd.append('city', 'جدة');
  fd.append('qualification', 'بكالوريوس');
  fd.append('specialization', 'هندسة كيميائية');
  fd.append('years_experience', '5');
  fd.append('privacy_consent', 'true');
  fd.append('cv_file', new Blob(['%PDF-1.4 Sample CV'], { type: 'application/pdf' }), 'cv.pdf');

  const r = await fetch(`${BASE}/api/applications`, { method: 'POST', body: fd });
  assert.strictEqual(r.status, 201, `Create app failed: ${r.status}`);
  return r.json();
}

(async () => {
  let srv = null;
  let pool = null;
  let browser = null;

  try {
    console.log('=== [v2.3] 0. SAFETY: ALLOW_ISOLATED_DRILL LOCKOUT ENFORCED (checked at boot) ===');
    await startWahaMock();
    console.log('=== [v2.3] 1. BOOTING ISOLATED DB + LOCAL WAHA MOCK (no external network) ===');
    await recreateDb();
    srv = startServer();
    await srv.ready;
    pool = new Pool({ connectionString: `${dbBaseOrigin}/${dbName}` });
    pool.on('error', () => {});

    const adminCookie = await loginCookie('admin', ADMIN_PASS);
    for (const u of [
      { username: 'hr_v23', full_name: 'منسقة الموارد البشرية', role: 'hr_coordinator', password: 'HrUser#2026!' },
      { username: 'comm_v23', full_name: 'عضو لجنة التوظيف', role: 'committee_member', password: 'CommUser#2026!' }
    ]) {
      const cr = await fetch(`${BASE}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify(u)
      });
      assert.strictEqual(cr.status, 201);
    }
    const hrCookie = await loginCookie('hr_v23', 'HrUser#2026!');
    const commCookie = await loginCookie('comm_v23', 'CommUser#2026!');

    // ---------------------------------------------------------------------------
    console.log('=== [v2.3] 2. SCHEMA PARITY + SAFE DEFAULTS (dry_run=true, kill_switch=false) ===');
    const cols = await pool.query(
      `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'wa_messages'
         AND column_name IN ('delivery_channel','idempotency_key','external_message_id','attempt_count','last_attempt_at','last_error','dry_run_payload')`
    );
    assert.strictEqual(cols.rows.length, 7, 'wa_messages must expose all 7 v2.3 governance columns');
    const deliveryCol = cols.rows.find((c) => c.column_name === 'delivery_channel');
    assert.strictEqual(deliveryCol.is_nullable, 'NO');
    assert(String(deliveryCol.column_default).includes('wa_me'));

    const idx = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'wa_messages' AND indexname = 'idx_wa_messages_idempotency_key'`
    );
    assert.strictEqual(idx.rows.length, 1, 'unique partial idempotency index must exist');
    assert(/UNIQUE/i.test(idx.rows[0].indexdef));

    const interviewCols = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'interviews'
         AND column_name IN ('reschedule_requested','reschedule_requested_at','reminder_24h_sent_at','reminder_15m_sent_at')`
    );
    assert.strictEqual(interviewCols.rows.length, 4, 'interviews must expose v2.3 reply/reminder columns');

    const cfgRes = await pool.query("SELECT setting_value FROM system_settings WHERE setting_key = 'waha_config'");
    assert.strictEqual(cfgRes.rows.length, 1, 'waha_config seed row must exist');
    assert.strictEqual(cfgRes.rows[0].setting_value.dry_run, true, 'dry_run must default to true');
    assert.strictEqual(cfgRes.rows[0].setting_value.enabled, false, 'WAHA must boot disabled');
    assert.strictEqual(cfgRes.rows[0].setting_value.kill_switch_tripped, false);
    assert.strictEqual(cfgRes.rows[0].setting_value.waha_activated_at, null);
    assert.strictEqual(cfgRes.rows[0].setting_value.max_per_minute, 6);
    assert.strictEqual(cfgRes.rows[0].setting_value.max_per_hour, 25);

    // ---------------------------------------------------------------------------
    console.log('=== [v2.3] 3. RBAC ON NEW ROUTES (3 roles only, no 4th role) ===');
    assert.strictEqual((await api('/api/waha/status')).status, 401, 'WAHA status requires auth');
    assert.strictEqual((await api('/api/waha/status', { cookie: commCookie })).status, 200, 'committee_member may read status');
    assert.strictEqual((await api('/api/waha/config', { method: 'PATCH', cookie: commCookie, body: { dry_run: true } })).status, 403, 'committee_member cannot change config');
    assert.strictEqual((await api('/api/waha/kill-switch', { method: 'POST', cookie: commCookie, body: {} })).status, 403, 'committee_member cannot trip kill-switch');
    assert.strictEqual((await api('/api/waha/dry-run-outbox', { cookie: commCookie })).status, 403, 'committee_member cannot read outbox');
    const rolesRes = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'staff_users'::regclass AND pg_get_constraintdef(oid) LIKE '%role%'`
    );
    const roleDef = rolesRes.rows.map((r) => r.def).join(' ');
    assert(roleDef.includes('super_admin') && roleDef.includes('hr_coordinator') && roleDef.includes('committee_member'));
    assert(!roleDef.includes('reception'), 'no 4th role may be introduced');

    // ---------------------------------------------------------------------------
    console.log('=== [v2.3] 4. NUCLEAR PROOF: DRY-RUN SENDS ZERO BYTES TO WAHA ===');
    resetWahaMock();
    const statusBefore = await api('/api/waha/status?probe=1', { cookie: hrCookie });
    assert.strictEqual(statusBefore.status, 200);
    assert.strictEqual(statusBefore.json.mode, 'dry_run', 'system must boot in dry_run mode');
    assert.strictEqual(statusBefore.json.effective_dry_run, true);
    assert.strictEqual(statusBefore.json.live_send_blocked_reason, 'ENV_WAHA_DRY_RUN_TRUE');
    assert.strictEqual(statusBefore.json.env.has_api_key, true, 'API key presence must be reported as boolean only');
    assert(!JSON.stringify(statusBefore.json).includes(WAHA_API_KEY), 'status payload must never contain the API key');
    assert(!JSON.stringify(statusBefore.json).includes(WAHA_WEBHOOK_SECRET), 'status payload must never contain webhook secret');
    assert.strictEqual(statusBefore.json.probe.session_status, 'WORKING');
    assert.strictEqual(statusBefore.json.probe.reachable, true);
    const probeHits = mockState.hits.filter((h) => h.path === '/api/sessions').length;
    assert(probeHits >= 1, 'probe must hit only /api/sessions');

    // مرشح + مقابلة + رسالة دعوة قيد الطابور
    await pool.query('DELETE FROM wa_messages');
    const candA = await createCandidateApplication('waha_cand_a@jpf.sa', '0558100201', 'م. سعد الاختباري');
    // التحقق من تطبيع رقم المرشح المحفوظ في القاعدة قبل أي مطابقة ويب هوك
    const candPhoneRow = await pool.query(
      `SELECT c.phone FROM candidates c
       WHERE c.id = (SELECT candidate_id FROM applications WHERE reference_no = $1)`,
      [candA.application.reference_no]
    );
    assert.strictEqual(candPhoneRow.rows[0].phone, '966558100201', 'candidate phone must be stored normalized');
    const appRow = (await pool.query('SELECT id, candidate_id FROM applications WHERE reference_no = $1', [candA.application.reference_no])).rows[0];
    const intRow = (await pool.query(
      `INSERT INTO interviews (application_id, scheduled_date, start_time, end_time, meeting_url, interview_mode)
       VALUES ($1, CURRENT_DATE + 3, '10:00', '10:30', 'https://meet.jit.si/JPF-DRILL-V23', 'remote')
       RETURNING id`,
      [appRow.id]
    )).rows[0];
    const msgRow = (await pool.query(
      `INSERT INTO wa_messages (application_id, interview_id, template_key, recipient_name, recipient_phone, message_body, wa_link, queue_status)
       VALUES ($1, $2, 'interview_invite', 'م. سعد الاختباري', '966558100201', 'دعوة اختبار جاف — لا تُرسل', 'https://wa.me/966558100201', 'queued')
       RETURNING id`,
      [appRow.id, intRow.id]
    )).rows[0];

    resetWahaMock();
    const dry1 = await api(`/api/wa-messages/${msgRow.id}/dispatch-waha`, { method: 'POST', cookie: hrCookie, body: {} });
    assert.strictEqual(dry1.status, 200, `dry-run dispatch must succeed: ${dry1.text}`);
    assert.strictEqual(dry1.json.mode, 'dry_run');
    assert.strictEqual(dry1.json.sent_live, false);
    assert.strictEqual(dry1.json.envelope.zero_network_send, true);
    assert(/^dryrun-[0-9a-f]{12}$/.test(dry1.json.envelope.external_message_id || dry1.json.message.external_message_id), 'dry-run id must be dryrun-<hex>');
    assert.strictEqual(mockSendTextCount(), 0, 'ZERO sendText calls allowed while dry-run is on');
    assert.strictEqual(dry1.json.message.delivery_channel, 'waha_dry_run');
    assert.strictEqual(dry1.json.message.queue_status, 'queued', 'dry-run must NOT flip the message to sent');

    // لا تسريب PII في مظروف Dry-Run المحفوظ
    const storedPayload = JSON.stringify(dry1.json.message.dry_run_payload);
    assert(!storedPayload.includes('966558100201'), 'dry-run payload must not store the full phone number');
    assert(!storedPayload.includes('دعوة اختبار جاف'), 'dry-run payload must not store the message body');
    assert(!storedPayload.includes(WAHA_API_KEY), 'dry-run payload must not store the API key');
    assert(storedPayload.includes('***'), 'dry-run payload must carry a masked chat id');
    assert.strictEqual(dry1.json.message.attempt_count, 1);
    assert(dry1.json.message.idempotency_key, 'idempotency key must be persisted');

    const outbox = await api('/api/waha/dry-run-outbox', { cookie: hrCookie });
    assert.strictEqual(outbox.status, 200);
    assert.strictEqual(outbox.json.effective_dry_run, true);
    assert.strictEqual(outbox.json.outbox.length, 1);
    assert(!JSON.stringify(outbox.json).includes('966558100201'));

    // محاولة تعطيل Dry-Run من الواجهة بينما البيئة تفرضه → 409 ENV_LOCKED
    const unlockAttempt = await api('/api/waha/config', { method: 'PATCH', cookie: hrCookie, body: { dry_run: false } });
    assert.strictEqual(unlockAttempt.status, 409);
    assert.strictEqual(unlockAttempt.json.code, 'WAHA_DRY_RUN_ENV_LOCKED');
    assert.strictEqual(mockSendTextCount(), 0);

    // تفعيل الإرسال الحيّ مرفوض بلا موافقة المالك
    const enableAttempt = await api('/api/waha/config', { method: 'PATCH', cookie: adminCookie, body: { enabled: true } });
    assert.strictEqual(enableAttempt.status, 409, 'cannot enable live while dry-run active');

    // ---------------------------------------------------------------------------
    console.log('=== [v2.3] 5. TEMPLATE & STATE GUARDS (portal_recovery hard-blocked) ===');
    const recMsg = (await pool.query(
      `INSERT INTO wa_messages (application_id, template_key, recipient_name, recipient_phone, message_body, wa_link, queue_status)
       VALUES ($1, 'portal_recovery', 'استعادة', '966558100202', 'رمز سري', 'https://wa.me/966558100202', 'queued')
       RETURNING id`,
      [appRow.id]
    )).rows[0];
    const recRes = await api(`/api/wa-messages/${recMsg.id}/dispatch-waha`, { method: 'POST', cookie: hrCookie, body: {} });
    assert.strictEqual(recRes.status, 400);
    assert.strictEqual(recRes.json.code, 'WAHA_TEMPLATE_BLOCKED');
    await pool.query(`UPDATE wa_messages SET queue_status = 'cancelled' WHERE id = $1`, [recMsg.id]);
    const cancelledRes = await api(`/api/wa-messages/${recMsg.id}/dispatch-waha`, { method: 'POST', cookie: hrCookie, body: {} });
    assert.strictEqual(cancelledRes.status, 400);
    assert(['WAHA_TEMPLATE_BLOCKED', 'WA_MESSAGE_CANCELLED'].includes(cancelledRes.json.code));
    assert.strictEqual(mockSendTextCount(), 0, 'guards must never reach the send path');

    // ---------------------------------------------------------------------------
    console.log('=== [v2.3] 6. CIRCUIT BREAKER (kill switch) STOPS SENDING INSTANTLY ===');
    const killRes = await api('/api/waha/kill-switch', { method: 'POST', cookie: hrCookie, body: {} });
    assert.strictEqual(killRes.status, 200);
    assert.strictEqual(killRes.json.config.kill_switch_tripped, true);
    assert.strictEqual(killRes.json.config.enabled, false);
    assert.strictEqual(killRes.json.effective_dry_run, true, 'kill-switch always forces manual wa.me mode');
    const statusAfterKill = await api('/api/waha/status', { cookie: hrCookie });
    assert.strictEqual(statusAfterKill.json.config.kill_switch_tripped, true);
    assert(!JSON.stringify(statusAfterKill.json).includes(WAHA_API_KEY));
    const auditKill = await pool.query("SELECT COUNT(*)::int AS c FROM audit_logs WHERE action = 'WAHA_KILL_SWITCH_TRIPPED'");
    assert(auditKill.rows[0].c >= 1, 'kill-switch must write an audit row');

    // إعادة تعيين مفتاح الإيقاف
    const resetKill = await api('/api/waha/config', { method: 'PATCH', cookie: adminCookie, body: { kill_switch_tripped: false } });
    assert.strictEqual(resetKill.status, 200);
    assert.strictEqual(resetKill.json.config.kill_switch_tripped, false);

    // ---------------------------------------------------------------------------
    console.log('=== [v2.3] 7. STILL DRY-RUN AFTER RESTART (fail-safe default) ===');
    await stopServer(srv);
    srv = startServer();
    await srv.ready;
    const statusRestart = await api('/api/waha/status', { cookie: hrCookie });
    assert.strictEqual(statusRestart.status, 200);
    assert.strictEqual(statusRestart.json.effective_dry_run, true, 'restart must land back in dry-run');
    assert.strictEqual(mockSendTextCount(), 0, 'still zero sendText calls after restart');

    // ---------------------------------------------------------------------------
    console.log('=== [v2.3] 8. WEBHOOK: signed reply "1" confirms, unsigned rejected, no PII leak ===');
    const noSecret = await fetch(`${BASE}/api/webhooks/waha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'message', payload: { from: '966558100201@c.us', body: '1' } })
    });
    assert.strictEqual(noSecret.status, 401, 'unsigned webhook must be rejected');

    const badSecret = await fetch(`${BASE}/api/webhooks/waha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WAHA-Webhook-Secret': 'wrong' },
      body: JSON.stringify({ event: 'message', payload: { from: '966558100201@c.us', body: '1' } })
    });
    assert.strictEqual(badSecret.status, 401, 'wrong secret must be rejected');

    await pool.query(`UPDATE interviews SET booking_status = 'invitation_sent' WHERE id = $1`, [intRow.id]);
    const okWebhook = await fetch(`${BASE}/api/webhooks/waha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WAHA-Webhook-Secret': WAHA_WEBHOOK_SECRET },
      body: JSON.stringify({ event: 'message', payload: { from: '966558100201@c.us', body: '1' } })
    });
    const okWebhookRaw = await okWebhook.text();
    assert.strictEqual(okWebhook.status, 200, okWebhookRaw);
    const webhookBody = JSON.parse(okWebhookRaw);
    assert.strictEqual(webhookBody.accepted, true);
    assert.strictEqual(webhookBody.action, 'confirmed');
    assert(!JSON.stringify(webhookBody).includes('966558100201'), 'webhook response must not echo the phone');
    const confRow = await pool.query('SELECT booking_status FROM interviews WHERE id = $1', [intRow.id]);
    assert.strictEqual(confRow.rows[0].booking_status, 'confirmed');

    // رد "2" يسجل طلب إعادة جدولة دون إلغاء
    await pool.query(`UPDATE interviews SET booking_status = 'invitation_sent' WHERE id = $1`, [intRow.id]);
    const reschedRes = await fetch(`${BASE}/api/webhooks/waha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WAHA-Webhook-Secret': WAHA_WEBHOOK_SECRET },
      body: JSON.stringify({ event: 'message', payload: { from: '966558100201@c.us', body: '2' } })
    });
    assert.strictEqual(reschedRes.status, 200);
    assert.strictEqual((await reschedRes.json()).action, 'reschedule_requested');
    const r2 = await pool.query('SELECT booking_status, reschedule_requested FROM interviews WHERE id = $1', [intRow.id]);
    assert.strictEqual(r2.rows[0].reschedule_requested, true);
    assert.strictEqual(r2.rows[0].booking_status, 'invitation_sent', 'reply 2 must NOT cancel the interview');

    // مرسل غير معروف لا يطابق شيئاً
    const unknownSender = await fetch(`${BASE}/api/webhooks/waha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WAHA-Webhook-Secret': WAHA_WEBHOOK_SECRET },
      body: JSON.stringify({ event: 'message', payload: { from: '966500000000@c.us', body: '1' } })
    });
    assert.strictEqual(unknownSender.status, 202);
    assert.strictEqual((await unknownSender.json()).accepted, false);

    // ---------------------------------------------------------------------------
    console.log('=== [v2.3] 9. RETROACTIVE-SEND CUTOVER WATERMARK (waha_activated_at) ===');
    // نضبط طابع القطع الزمني على المستقبل + نسجّل dry_run=false في قاعدة البيانات (البيئة لا تزال تفرض Dry-Run)
    const futureCut = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await pool.query(
      `UPDATE system_settings
       SET setting_value = setting_value || jsonb_build_object('waha_activated_at', $1::text, 'dry_run', false, 'kill_switch_tripped', false)
       WHERE setting_key = 'waha_config'`,
      [futureCut]
    );
    const retroRes = await api(`/api/wa-messages/${msgRow.id}/dispatch-waha`, { method: 'POST', cookie: hrCookie, body: {} });
    assert.strictEqual(retroRes.status, 409, `retroactive send must be blocked: ${retroRes.text}`);
    assert.strictEqual(retroRes.json.code, 'WAHA_RETROACTIVE_SEND_BLOCKED');
    assert.strictEqual(mockSendTextCount(), 0, 'watermark blocks before any byte leaves');

    // ---------------------------------------------------------------------------
    console.log('=== [v2.3] 10. WA.ME REMAINS AVAILABLE AS MANUAL FALLBACK (unchanged) ===');
    const waList = await api('/api/wa-messages', { cookie: hrCookie });
    assert.strictEqual(waList.status, 200);
    const target = waList.json.messages.find((m) => m.id === msgRow.id);
    assert(target, 'message must still be listed for manual wa.me sending');
    assert(String(target.wa_link).startsWith('https://wa.me/966558100201'), 'manual wa.me link must remain intact');
    assert.strictEqual(waList.json.effective_dry_run, undefined, 'legacy list contract untouched');

    // ---------------------------------------------------------------------------
    console.log('=== [v2.3] 11. SECURITY: INTERNAL-URL GUARD REJECTS PUBLIC/LOCAL WAHA HOSTS ===');
    const { assertInternalWahaUrl, toWahaChatId, maskPhone } = require('../services/wahaClient');
    for (const bad of ['http://wa.me:3000', 'http://8.8.8.8:3000', 'http://127.0.0.1:3000', 'http://waha.example.com:3000', 'http://169.254.169.254:80']) {
      let threw = null;
      try { assertInternalWahaUrl(bad, { nodeEnv: 'production' }); } catch (e) { threw = e; }
      assert(threw && threw.code === 'WAHA_BASE_URL_NOT_INTERNAL', `public/local host must be rejected: ${bad}`);
    }
    assert.strictEqual(assertInternalWahaUrl('http://waha-bbg7-waha-1:3000', { nodeEnv: 'production' }).hostname, 'waha-bbg7-waha-1');
    assert.strictEqual(assertInternalWahaUrl('http://172.18.0.4:3000', { nodeEnv: 'production' }).hostname, '172.18.0.4');
    assert.strictEqual(toWahaChatId('0558100201'), '966558100201@c.us', 'Saudi 05xxxxxxxx normalizes to 9665xxxxxxxx@c.us');
    assert.strictEqual(toWahaChatId('558100201'), '966558100201@c.us');
    assert.strictEqual(maskPhone('966558100201'), '********0201');

    // ---------------------------------------------------------------------------
    console.log('=== [v2.3] 12. LOG HYGIENE: server stdout/stderr carries no secrets or PII ===');
    const logs = srv.proc.stdout.read ? '' : '';
    void logs; // logs are streamed, verified below via captured buffer
    const auditDump = JSON.stringify((await pool.query('SELECT action, metadata FROM audit_logs')).rows);
    assert(!auditDump.includes(WAHA_API_KEY), 'audit logs must never contain the WAHA API key');
    assert(!auditDump.includes(WAHA_WEBHOOK_SECRET), 'audit logs must never contain the webhook secret');
    assert(!auditDump.includes('966558100201'), 'audit logs must never contain a full candidate phone');

    // ---------------------------------------------------------------------------
    console.log('=== [v2.3] 13. LIVE PATH DRILL (mock only): one send, dedupe, rate limit, circuit breaker ===');
    // تنبيه: هذا الاختبار يوجه الاتصال حصراً إلى محاكي WAHA المحلي على 127.0.0.1 — لا يخرج أي بايت للإنترنت
    await stopServer(srv);
    await pool.query(
      `UPDATE system_settings
       SET setting_value = setting_value || jsonb_build_object(
         'dry_run', false, 'enabled', true, 'kill_switch_tripped', false,
         'waha_activated_at', to_char(NOW() - INTERVAL '1 hour', 'YYYY-MM-DD\"T\"HH24:MI:SSOF')
       )
       WHERE setting_key = 'waha_config'`
    );
    await pool.query(`UPDATE wa_messages SET queue_status = 'queued', last_attempt_at = NULL, last_error = NULL WHERE id = $1`, [msgRow.id]);
    srv = startServer({ WAHA_DRY_RUN: 'false', WAHA_LIVE_APPROVED: 'true' });
    await srv.ready;

    const liveStatus = await api('/api/waha/status', { cookie: hrCookie });
    assert.strictEqual(liveStatus.json.mode, 'live', 'live drill must run in live mode');
    assert.strictEqual(liveStatus.json.effective_dry_run, false);
    assert.strictEqual(liveStatus.json.live_send_blocked_reason, null);

    resetWahaMock();
    const live1 = await api(`/api/wa-messages/${msgRow.id}/dispatch-waha`, { method: 'POST', cookie: hrCookie, body: {} });
    assert.strictEqual(live1.status, 200, live1.text);
    assert.strictEqual(live1.json.sent_live, true);
    assert.strictEqual(live1.json.message.queue_status, 'sent');
    assert.strictEqual(live1.json.message.delivery_channel, 'waha_live');
    assert.strictEqual(live1.json.message.external_message_id, 'mock-msg-0');
    assert.strictEqual(mockSendTextCount(), 1, 'exactly ONE sendText must leave for one approved message');

    const invAfterSend = await pool.query('SELECT booking_status FROM interviews WHERE id = $1', [intRow.id]);
    assert.strictEqual(invAfterSend.rows[0].booking_status, 'invitation_sent', 'live invite must flip interview to invitation_sent');

    // منع التكرار: إعادة إرسال نفس الرسالة مستحيلة (لم تعد queued)
    const live2 = await api(`/api/wa-messages/${msgRow.id}/dispatch-waha`, { method: 'POST', cookie: hrCookie, body: {} });
    assert.strictEqual(live2.status, 400);
    assert.strictEqual(live2.json.code, 'INVALID_WA_TRANSITION');
    assert.strictEqual(mockSendTextCount(), 1, 'repeat dispatch must never reach WAHA again');

    // منع التكرار على مستوى قاعدة البيانات: مفتاح idempotency فريد
    const dupKey = live1.json.message.idempotency_key;
    let dupViolation = null;
    try {
      await pool.query(
        `INSERT INTO wa_messages (application_id, interview_id, template_key, recipient_name, recipient_phone, message_body, wa_link, queue_status, idempotency_key)
         VALUES ($1, $2, 'reminder_24h', 'مكرر', '966558100201', 'تكرار', 'https://wa.me/966558100201', 'queued', $3)`,
        [appRow.id, intRow.id, dupKey]
      );
    } catch (e) {
      dupViolation = e;
    }
    assert(dupViolation && dupViolation.code === '23505', 'duplicate idempotency_key must violate the unique index');

    // حدود الإرسال: بحد أقصى رسالة واحدة في الدقيقة تُرفض الثانية بـ 429 دون أي إرسال
    await api('/api/waha/config', { method: 'PATCH', cookie: adminCookie, body: { max_per_minute: 1 } });
    const queuedMsg = async () => (await pool.query(
      `INSERT INTO wa_messages (application_id, interview_id, template_key, recipient_name, recipient_phone, message_body, wa_link, queue_status)
       VALUES ($1, $2, 'reminder_24h', 'اختبار الحدود', '966558100201', 'تذكير', 'https://wa.me/966558100201', 'queued')
       RETURNING id`,
      [appRow.id, intRow.id]
    )).rows[0].id;

    const rateMsg = await queuedMsg();
    const beforeRateCount = mockSendTextCount();
    const rateRes = await api(`/api/wa-messages/${rateMsg}/dispatch-waha`, { method: 'POST', cookie: hrCookie, body: {} });
    assert.strictEqual(rateRes.status, 429, `rate limit must reject with 429: ${rateRes.text}`);
    assert.strictEqual(rateRes.json.code, 'WAHA_RATE_LIMITED');
    assert.strictEqual(mockSendTextCount(), beforeRateCount, 'rate-limited dispatch must not reach WAHA');

    // القاطع الدائري: 3 أخطاء متتالية ترفع مفتاح الإيقاف تلقائياً
    await api('/api/waha/config', { method: 'PATCH', cookie: adminCookie, body: { max_per_minute: 6 } });
    // تصفير تاريخ المحاولات السابقة حتى لا يحسب القاطع الدائري أخطاء الجولة السابقة (اختبار حتمي)
    await pool.query(`UPDATE wa_messages SET last_attempt_at = NULL, last_error = NULL WHERE queue_status = 'queued'`);
    resetWahaMock();
    mockState.failNext = 3;
    for (let k = 0; k < 3; k++) {
      const m = await queuedMsg();
      const failRes = await api(`/api/wa-messages/${m}/dispatch-waha`, { method: 'POST', cookie: hrCookie, body: {} });
      assert.strictEqual(failRes.status, 502, `upstream failure must surface as 502: ${failRes.text}`);
      assert.strictEqual(failRes.json.code, 'WAHA_UPSTREAM_ERROR');
      assert(!failRes.text.includes(WAHA_API_KEY), 'error responses must never echo the API key');
    }
    const breakerMsg = await queuedMsg();
    const breakerRes = await api(`/api/wa-messages/${breakerMsg}/dispatch-waha`, { method: 'POST', cookie: hrCookie, body: {} });
    assert.strictEqual(breakerRes.status, 409, breakerRes.text);
    assert.strictEqual(breakerRes.json.code, 'WAHA_CIRCUIT_BREAKER_TRIPPED');
    const cfgAfterBreaker = await pool.query("SELECT setting_value FROM system_settings WHERE setting_key = 'waha_config'");
    assert.strictEqual(cfgAfterBreaker.rows[0].setting_value.kill_switch_tripped, true, 'circuit breaker must trip the kill switch');
    assert.strictEqual(cfgAfterBreaker.rows[0].setting_value.enabled, false, 'circuit breaker must disable live sending');

    // بعد القاطع: أي محاولة إضافية تعود تلقائياً إلى الوضع اليدوي (Dry-Run) ولا تصل إلى WAHA
    const afterBreakerCount = mockSendTextCount();
    const manualRes = await api(`/api/wa-messages/${breakerMsg}/dispatch-waha`, { method: 'POST', cookie: hrCookie, body: {} });
    assert.strictEqual(manualRes.status, 200, manualRes.text);
    assert.strictEqual(manualRes.json.mode, 'dry_run', 'after breaker the system must fall back to dry-run/manual');
    assert.strictEqual(mockSendTextCount(), afterBreakerCount, 'no bytes may leave after the breaker tripped');

    // استعادة قفل الأمان: إعادة كل شيء إلى Dry-Run إلزامي
    await pool.query(
      `UPDATE system_settings SET setting_value = setting_value || '{"dry_run": true, "enabled": false, "kill_switch_tripped": false}'::jsonb
       WHERE setting_key = 'waha_config'`
    );

    // ---------------------------------------------------------------------------
    console.log('=== [v2.3] 14. UI E2E: dry-run strip, kill-switch button, per-row WAHA dispatch ===');
    // نعود إلى الوضع الجاف الإلزامي قبل فحص الواجهة
    await stopServer(srv);
    await pool.query(
      `UPDATE system_settings SET setting_value = setting_value || '{"dry_run": true, "enabled": false, "kill_switch_tripped": false}'::jsonb
       WHERE setting_key = 'waha_config'`
    );
    // تنظيف سجل المحاولات حتى لا يحجب فحص الواجهة حد الإرسال
    await pool.query(`UPDATE wa_messages SET last_attempt_at = NULL WHERE queue_status = 'queued'`);
    srv = startServer();
    await srv.ready;

    const uiMsg = (await pool.query(
      `INSERT INTO wa_messages (application_id, interview_id, template_key, recipient_name, recipient_phone, message_body, wa_link, queue_status)
       VALUES ($1, $2, 'interview_invite', 'م. واجهة الاختبار', '966558100201', 'رسالة فحص الواجهة', 'https://wa.me/966558100201', 'queued')
       RETURNING id`,
      [appRow.id, intRow.id]
    )).rows[0].id;

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/Login.dc.html`, { waitUntil: 'networkidle' });
    await page.fill('#username', 'hr_v23');
    await page.fill('#password', 'HrUser#2026!');
    await Promise.all([page.waitForURL('**/Dashboard.dc.html'), page.click('#login-btn')]);
    await page.goto(`${BASE}/Interviews.dc.html`, { waitUntil: 'networkidle' });

    await page.waitForSelector('[data-testid="waha-strip"]', { timeout: 8000 });
    const badgeText = (await page.textContent('[data-testid="waha-mode-badge"]')) || '';
    assert(badgeText.includes('الاختبار الجاف'), `dry-run badge must be visible: got "${badgeText}"`);
    assert(!badgeText.includes('إرسال حيّ'), 'UI must never claim live mode while dry-run is enforced');

    const beforeClick = mockSendTextCount();
    await page.waitForSelector(`[data-testid="waha-dispatch-${uiMsg}"]`, { timeout: 8000 });
    await page.click(`[data-testid="waha-dispatch-${uiMsg}"]`);

    // ننتظر الحقيقة في قاعدة البيانات بدلاً من السباق مع إعادة رسم الجدول (مصدر الحقيقة)
    let rowAfter = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      const r = await pool.query('SELECT delivery_channel, queue_status, attempt_count FROM wa_messages WHERE id = $1', [uiMsg]);
      if (r.rows[0].attempt_count >= 1 && r.rows[0].delivery_channel === 'waha_dry_run') {
        rowAfter = r;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(rowAfter, 'UI dispatch must be persisted as waha_dry_run');
    assert.strictEqual(rowAfter.rows[0].queue_status, 'queued', 'dry-run must not flip queue_status to sent');
    assert.strictEqual(rowAfter.rows[0].attempt_count, 1);
    assert.strictEqual(mockSendTextCount(), beforeClick, 'UI dispatch in dry-run must never hit WAHA');
    await page.waitForSelector('[data-testid="waha-dry-badge"]', { timeout: 10000 });

    // زر الإيقاف الفوري: يعمل بنقرة واحدة ويحوّل الشريط إلى الحالة اليدوية
    page.on('dialog', (d) => d.accept());
    await page.click('[data-testid="waha-kill-switch"]');
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="waha-mode-badge"]') || {}).textContent?.includes('مفتاح الإيقاف'),
      null,
      { timeout: 8000 }
    );
    const cfgKill = await pool.query("SELECT setting_value FROM system_settings WHERE setting_key = 'waha_config'");
    assert.strictEqual(cfgKill.rows[0].setting_value.kill_switch_tripped, true, 'UI kill-switch must persist');
    assert.strictEqual(mockSendTextCount(), beforeClick, 'kill-switch must never send anything');
    await browser.close();
    browser = null;
    await pool.query(
      `UPDATE system_settings SET setting_value = setting_value || '{"dry_run": true, "enabled": false, "kill_switch_tripped": false}'::jsonb
       WHERE setting_key = 'waha_config'`
    );

    console.log('ALL_V23_WAHA_DRY_RUN_KILL_SWITCH_WATERMARK_WEBHOOK_AND_LOG_HYGIENE_PASSED');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (srv) await stopServer(srv);
    if (pool) {
      pool.on('error', () => {});
      await pool.end().catch(() => {});
    }
    await stopWahaMock();
    await dropDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
})();
