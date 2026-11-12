#!/usr/bin/env node
/**
 * مجموعة التحقق الشاملة والمعزولة للمرحلة 2 (v2.2b — Optional 60s Voice Pitch + Governance + 30d Auto-Purge)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client, Pool } = require('pg');
const { chromium } = require('playwright');

if (process.env.ALLOW_ISOLATED_DRILL !== '1') {
  console.error('[SAFETY_LOCKOUT] يلزم تمرير ALLOW_ISOLATED_DRILL=1 لتشغيل verify-v22b.js.');
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
const dbName = `jpf_iso_v22b_${runSuffix}`;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jpf-v22b-'));
const uploadsDir = path.join(tmpRoot, 'uploads');
fs.mkdirSync(path.join(uploadsDir, 'public'), { recursive: true });

const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASS = 'V22B-Drill-Pass-2026!';
const SESSION_SECRET = 'v22b-isolated-hmac-secret-key-2026';

// مولّد ملف WAV قياسي صغير صالح ثنائياً (RIFF....WAVEfmt data) لمدة 2 ثانية بتردد 8000Hz
function buildValidWavBuffer(durationSec = 2) {
  const sampleRate = 8000;
  const numSamples = sampleRate * durationSec;
  const dataSize = numSamples; // 8-bit mono PCM
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20);  // AudioFormat = 1 (PCM)
  buf.writeUInt16LE(1, 22);  // NumChannels = 1
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate, 28);
  buf.writeUInt16LE(1, 32);  // BlockAlign
  buf.writeUInt16LE(8, 34);  // BitsPerSample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    buf[44 + i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
  }
  return buf;
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
      SESSION_SECRET,
      VOICE_UPLOAD_MAX_PER_WINDOW: '14'
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
      if (s) console.error('[v22b stderr]:', s);
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
  return (r.headers.get('set-cookie') || '').split(';')[0];
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
  const setCookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const body = await r.json();
  return { body, cookie: setCookie };
}

(async () => {
  let srv = null;
  let pool = null;
  let browser = null;

  try {
    console.log('=== [v2.2b] 1. BOOTING ISOLATED DB & SERVER ===');
    await recreateDb();
    srv = startServer();
    await srv.ready;

    pool = new Pool({ connectionString: `${dbBaseOrigin}/${dbName}` });
    pool.on('error', () => {});

    const adminCookie = await loginCookie('admin', ADMIN_PASS);
    for (const u of [
      { username: 'hr_v22b', full_name: 'منسقة الموارد البشرية', role: 'hr_coordinator', password: 'HrUser#2026!' },
      { username: 'comm_v22b', full_name: 'عضو لجنة التوظيف', role: 'committee_member', password: 'CommUser#2026!' }
    ]) {
      const cr = await fetch(`${BASE}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify(u)
      });
      assert.strictEqual(cr.status, 201);
    }
    const hrCookie = await loginCookie('hr_v22b', 'HrUser#2026!');
    const commCookie = await loginCookie('comm_v22b', 'CommUser#2026!');

    console.log('=== [v2.2b] 2. CONSENT GATE, PoP OWNERSHIP, MAGIC-BYTE SNIFFER & 2.5MB CAP ===');
    const candA = await createCandidateApplication('voice_cand_a@jpf.sa', '0558100101', 'م. فهد الصوتي');
    const refA = candA.body.application.reference_no;
    const keyA = candA.body.access_key;
    const wavBuf = buildValidWavBuffer(2);

    // 2A. رفض الرفع بدون الموافقة الصريحة (400 VOICE_CONSENT_REQUIRED)
    const fdNoConsent = new FormData();
    fdNoConsent.append('voice_consent', 'false');
    fdNoConsent.append('duration_sec', '25');
    fdNoConsent.append('voice_file', new Blob([wavBuf], { type: 'audio/wav' }), 'pitch.wav');
    const noConsentRes = await fetch(`${BASE}/api/applications/${refA}/voice-pitch`, {
      method: 'POST',
      headers: { 'X-Candidate-Key': keyA },
      body: fdNoConsent
    });
    assert.strictEqual(noConsentRes.status, 400);
    assert.strictEqual((await noConsentRes.json()).code, 'VOICE_CONSENT_REQUIRED');

    // 2B. رفض الرفع بدون إثبات ملكية المتقدم (403 CANDIDATE_OWNERSHIP_REQUIRED)
    const fdNoAuth = new FormData();
    fdNoAuth.append('voice_consent', 'true');
    fdNoAuth.append('duration_sec', '25');
    fdNoAuth.append('voice_file', new Blob([wavBuf], { type: 'audio/wav' }), 'pitch.wav');
    const noAuthRes = await fetch(`${BASE}/api/applications/${refA}/voice-pitch`, {
      method: 'POST',
      body: fdNoAuth
    });
    assert.strictEqual(noAuthRes.status, 403);

    // 2C. رفض ملف خبيث منتحل لامتداد صوتي (HTML/EXE متنكر كـ .webm -> 400 UNSUPPORTED_AUDIO_BINARY)
    const fdSpoof = new FormData();
    fdSpoof.append('voice_consent', 'true');
    fdSpoof.append('duration_sec', '20');
    fdSpoof.append('voice_file', new Blob(['<html><script>alert(1)</script></html>'], { type: 'audio/webm' }), 'attack.webm');
    const spoofRes = await fetch(`${BASE}/api/applications/${refA}/voice-pitch`, {
      method: 'POST',
      headers: { 'X-Candidate-Key': keyA },
      body: fdSpoof
    });
    assert.strictEqual(spoofRes.status, 400);
    assert.strictEqual((await spoofRes.json()).code, 'UNSUPPORTED_AUDIO_BINARY');

    // 2D. رفض ملف يتجاوز 2.5 ميجابايت (400 VOICE_FILE_TOO_LARGE)
    const hugeBuf = Buffer.alloc(Math.round(2.7 * 1024 * 1024), 0x41);
    const fdHuge = new FormData();
    fdHuge.append('voice_consent', 'true');
    fdHuge.append('duration_sec', '30');
    fdHuge.append('voice_file', new Blob([hugeBuf], { type: 'audio/wav' }), 'huge.wav');
    const hugeRes = await fetch(`${BASE}/api/applications/${refA}/voice-pitch`, {
      method: 'POST',
      headers: { 'X-Candidate-Key': keyA },
      body: fdHuge
    });
    assert.strictEqual(hugeRes.status, 400);
    assert.strictEqual((await hugeRes.json()).code, 'VOICE_FILE_TOO_LARGE');

    // 2E. نجاح رفع ملف WAV صالح مع إثبات الملكية والموافقة
    const fdValid = new FormData();
    fdValid.append('voice_consent', 'true');
    fdValid.append('duration_sec', '28');
    fdValid.append('voice_file', new Blob([wavBuf], { type: 'audio/wav' }), 'pitch.wav');
    const upRes = await fetch(`${BASE}/api/applications/${refA}/voice-pitch`, {
      method: 'POST',
      headers: { 'X-Candidate-Key': keyA },
      body: fdValid
    });
    assert.strictEqual(upRes.status, 201);

    console.log('=== [v2.2b] 3. DIRECT STATIC LOCKOUT, AUDITED RANGE STREAMING & HUMAN REVIEW ===');
    const dbRowA = (await pool.query('SELECT id, voice_pitch_path FROM applications WHERE reference_no = $1', [refA])).rows[0];
    assert(dbRowA.voice_pitch_path, 'voice_pitch_path must be stored in DB');

    // حتى الموظف المسجل يُمنع من فتح /uploads/voice_pitches/* مباشرةً لتفادي تجاوز سجل التدقيق
    const directStaffTry = await fetch(`${BASE}/uploads/voice_pitches/${dbRowA.voice_pitch_path}`, {
      headers: { Cookie: adminCookie }
    });
    assert.strictEqual(directStaffTry.status, 403, 'Direct static /uploads/voice_pitches access must return 403');

    // الزائر المجهول يُمنع من واجهة البث (401)
    const anonStream = await fetch(`${BASE}/api/applications/${dbRowA.id}/voice-stream`);
    assert.strictEqual(anonStream.status, 401);

    // عضو اللجنة يستمع عبر HTTP Range فيحصل على 206 Partial Content ويُسجَّل الحدث في audit_logs
    const rangeStream = await fetch(`${BASE}/api/applications/${dbRowA.id}/voice-stream`, {
      headers: { Cookie: commCookie, Range: 'bytes=0-63' }
    });
    assert.strictEqual(rangeStream.status, 206);
    assert.strictEqual(rangeStream.headers.get('cache-control'), 'private, no-store');
    const chunkBytes = Buffer.from(await rangeStream.arrayBuffer());
    assert.strictEqual(chunkBytes.length, 64);

    const playAudit = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_logs WHERE action = 'VOICE_PITCH_PLAYED' AND entity_id = $1`,
      [refA]
    );
    assert.strictEqual(playAudit.rows[0].cnt, 1, 'VOICE_PITCH_PLAYED must be logged in audit_logs');

    // عضو اللجنة يُقيّم التعريف الصوتي بشرياً (+4.5) ولا يُسمح له بحذف المقطع (403)
    const revRes = await fetch(`${BASE}/api/applications/${dbRowA.id}/voice-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: commCookie },
      body: JSON.stringify({ voice_bonus_score: 4.5, voice_review_notes: 'عرض واضح ومهني جداً خلال 28 ثانية.' })
    });
    assert.strictEqual(revRes.status, 200);

    const commDelTry = await fetch(`${BASE}/api/applications/${dbRowA.id}/voice-pitch`, {
      method: 'DELETE',
      headers: { Cookie: commCookie }
    });
    assert.strictEqual(commDelTry.status, 403, 'committee_member must not delete candidate voice pitch');

    console.log('=== [v2.2b] 4. 30-DAY AUTO-PURGE FOR NON-SELECTED vs EXEMPTION FOR OFFERED ===');
    // إنشاء مرشح ثانٍ يرفع مقطعاً صوتياً يبقى غير مختار (passed_assessment / under_review)، بينما المرشح الأول يحصل على عرض وظيفي (offered)
    const candB = await createCandidateApplication('voice_cand_b@jpf.sa', '0558100102', 'أ. ريم غير المختارة');
    const refB = candB.body.application.reference_no;
    const keyB = candB.body.access_key;

    const fdB = new FormData();
    fdB.append('voice_consent', 'true');
    fdB.append('duration_sec', '22');
    fdB.append('voice_file', new Blob([wavBuf], { type: 'audio/wav' }), 'pitchB.wav');
    assert.strictEqual(
      (await fetch(`${BASE}/api/applications/${refB}/voice-pitch`, { method: 'POST', headers: { 'X-Candidate-Key': keyB }, body: fdB })).status,
      201
    );

    // ترقية حالة المرشح الأول إلى passed_assessment ثم منح عرض وظيفي (offered) عبر الموارد البشرية
    await pool.query(`UPDATE applications SET status = 'passed_assessment', assessed_at = NOW(), assessment_score = 88 WHERE id = $1`, [dbRowA.id]);
    const offerStatusRes = await fetch(`${BASE}/api/applications/${dbRowA.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify({ status: 'offered' })
    });
    assert.strictEqual(offerStatusRes.status, 200);

    // تقديم تاريخ انتهاء الاحتفاظ للمرشح الثاني غير المختار إلى الماضي وتشغيل دورة التطهير
    const dbRowB = (await pool.query('SELECT id, voice_pitch_path FROM applications WHERE reference_no = $1', [refB])).rows[0];
    const diskPathA = path.join(uploadsDir, 'voice_pitches', dbRowA.voice_pitch_path);
    const diskPathB = path.join(uploadsDir, 'voice_pitches', dbRowB.voice_pitch_path);
    assert(fs.existsSync(diskPathA) && fs.existsSync(diskPathB), 'Both voice files must exist on disk before purge');

    await pool.query(
      `UPDATE applications SET voice_retention_expires_at = NOW() - INTERVAL '2 hours' WHERE id = $1`,
      [dbRowB.id]
    );

    // 4B. التحقق من منع اللجنة من الاستماع لتسجيل منتهي الصلاحية حتى قبل تشغيل دورة التطهير الدورية (410 VOICE_RETENTION_EXPIRED + حذف فوري)
    const expiredStreamTry = await fetch(`${BASE}/api/applications/${dbRowB.id}/voice-stream`, {
      headers: { Cookie: commCookie }
    });
    assert.strictEqual(expiredStreamTry.status, 410, 'Streaming an expired voice recording MUST return 410 Gone');
    assert.strictEqual((await expiredStreamTry.json()).code, 'VOICE_RETENTION_EXPIRED');
    assert(!fs.existsSync(diskPathB), 'Expired voice file B must be unlinked from disk immediately upon expiry guard');
    assert(fs.existsSync(diskPathA), 'Selected (offered) candidate voice file A must remain intact on disk');

    // 4C. التحقق من كنس الملفات اليتيمة على القرص (Orphan File Sweep بعد مهلة السماح)
    const orphanFile = path.join(uploadsDir, 'voice_pitches', 'voice-999999-orphan.wav');
    fs.writeFileSync(orphanFile, wavBuf);
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(orphanFile, tenMinAgo, tenMinAgo);
    assert(fs.existsSync(orphanFile));

    const purgeRes = await fetch(`${BASE}/api/system/purge-expired-voice`, {
      method: 'POST',
      headers: { Cookie: hrCookie }
    });
    assert.strictEqual(purgeRes.status, 200);
    const purgeBody = await purgeRes.json();
    assert(purgeBody.swept_orphan_count >= 1, 'Orphan voice file must be swept');
    assert(!fs.existsSync(orphanFile), 'Orphan file must be deleted from disk');

    // 4D. التحقق من علم تعطيل الميزة (503 VOICE_PITCH_DISABLED قبل استهلاك الذاكرة أو القرص)
    const disableCfgRes = await fetch(`${BASE}/api/system/voice-pitch-config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify({ enabled: false })
    });
    assert.strictEqual(disableCfgRes.status, 200);

    const fdWhenDisabled = new FormData();
    fdWhenDisabled.append('voice_consent', 'true');
    fdWhenDisabled.append('duration_sec', '15');
    fdWhenDisabled.append('voice_file', new Blob([wavBuf], { type: 'audio/wav' }), 'disabled.wav');
    const disabledUploadRes = await fetch(`${BASE}/api/applications/${refB}/voice-pitch`, {
      method: 'POST',
      headers: { 'X-Candidate-Key': keyB },
      body: fdWhenDisabled
    });
    assert.strictEqual(disabledUploadRes.status, 503, 'Disabled voice feature must reject uploads with 503');
    assert.strictEqual((await disabledUploadRes.json()).code, 'VOICE_PITCH_DISABLED');

    // إعادة تفعيل الميزة لاختبار المتصفح وحدود المعدل
    await fetch(`${BASE}/api/system/voice-pitch-config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify({ enabled: true, max_uploads_per_application: 3 })
    });

    console.log('=== [v2.2b] 5. HEADLESS CHROMIUM E2E: CANDIDATE VOICE WIDGET & COMMITTEE REVIEW ===');
    browser = await chromium.launch({ headless: true });

    // إنشاء مرشح ثالث يفتح Assessment.dc.html ويرفع ملف WAV من داخل الواجهة الاختيارية بدون ميكروفون حي ثم ينهي الاختبار
    const candC = await createCandidateApplication('voice_cand_c@jpf.sa', '0558100103', 'م. نواف المتصفح');
    const refC = candC.body.application.reference_no;
    const keyC = candC.body.access_key;
    const wavFileTmp = path.join(tmpRoot, 'browser-pitch.wav');
    fs.writeFileSync(wavFileTmp, wavBuf);

    const candCtx = await browser.newContext();
    const candPage = await candCtx.newPage();
    await candPage.goto(`${BASE}/Assessment.dc.html?ref=${encodeURIComponent(refC)}`, { waitUntil: 'networkidle' });
    // التحقق بمفتاح الدخول السري للمتقدم
    await candPage.waitForSelector('#cvf-key', { timeout: 8000 });
    await candPage.fill('#cvf-key', keyC);
    await candPage.click('#cvf-submit');

    await candPage.waitForSelector('#voice-pitch-card', { timeout: 8000 });
    await candPage.check('#voice-consent-chk');
    await candPage.setInputFiles('#voice-file-input', wavFileTmp);
    await candPage.waitForSelector('#voice-upload-btn', { state: 'visible', timeout: 5000 });
    await candPage.click('#voice-upload-btn');
    await candPage.waitForSelector('#voice-saved-banner', { timeout: 8000 });

    // عضو اللجنة يفتح ملف المرشح الثالث ويرى مشغل الصوت ويعتمد درجة التميز 5.0
    const commCtx = await browser.newContext();
    const commPage = await commCtx.newPage();
    await commPage.goto(`${BASE}/Login.dc.html`, { waitUntil: 'networkidle' });
    await commPage.fill('#username', 'comm_v22b');
    await commPage.fill('#password', 'CommUser#2026!');
    await Promise.all([commPage.waitForURL('**/Dashboard.dc.html'), commPage.click('#login-btn')]);

    await commPage.goto(`${BASE}/CandidateProfile.dc.html?app_id=${encodeURIComponent(refC)}`, { waitUntil: 'networkidle' });
    await commPage.waitForSelector('#committee-voice-player', { timeout: 8000 });
    await commPage.fill('#vr-bonus-score', '5');
    await commPage.fill('#vr-notes', 'تواصل قيادي ممتاز في الدقيقة الصوتية.');
    await commPage.click('#save-voice-review-btn');
    await commPage.waitForSelector('input[value="عضو لجنة التوظيف"]', { timeout: 8000 });

    console.log('=== [v2.2b] 6. PER-APPLICATION CAP & DEDICATED IP RATE LIMITER (429) ===');
    // المرشح الثالث رفع مرة واحدة عبر المتصفح؛ نرفع مرتين إضافيتين ليصل إلى السقف (3)، والمحاولة الرابعة تُرفض بـ 429 VOICE_APPLICATION_UPLOAD_CAP_REACHED
    for (let k = 0; k < 2; k++) {
      const fdExtra = new FormData();
      fdExtra.append('voice_consent', 'true');
      fdExtra.append('duration_sec', '18');
      fdExtra.append('voice_file', new Blob([wavBuf], { type: 'audio/wav' }), `extra-${k}.wav`);
      const rExtra = await fetch(`${BASE}/api/applications/${refC}/voice-pitch`, {
        method: 'POST',
        headers: { 'X-Candidate-Key': keyC },
        body: fdExtra
      });
      assert.strictEqual(rExtra.status, 201);
    }
    const fdCap = new FormData();
    fdCap.append('voice_consent', 'true');
    fdCap.append('duration_sec', '18');
    fdCap.append('voice_file', new Blob([wavBuf], { type: 'audio/wav' }), 'cap-exceeded.wav');
    const capRes = await fetch(`${BASE}/api/applications/${refC}/voice-pitch`, {
      method: 'POST',
      headers: { 'X-Candidate-Key': keyC },
      body: fdCap
    });
    assert.strictEqual(capRes.status, 429, '4th upload on same application must hit 429 VOICE_APPLICATION_UPLOAD_CAP_REACHED');
    assert.strictEqual((await capRes.json()).code, 'VOICE_APPLICATION_UPLOAD_CAP_REACHED');

    // استنفاد نافذة معدل الـ IP المخصصة (VOICE_UPLOAD_MAX_PER_WINDOW=14) والتأكد من رجوع 429 VOICE_UPLOAD_RATE_LIMITED
    let sawIpRateLimit = false;
    for (let m = 0; m < 10; m++) {
      const fdBurst = new FormData();
      fdBurst.append('voice_consent', 'true');
      fdBurst.append('duration_sec', '10');
      fdBurst.append('voice_file', new Blob([wavBuf], { type: 'audio/wav' }), 'burst.wav');
      const burstRes = await fetch(`${BASE}/api/applications/${refB}/voice-pitch`, {
        method: 'POST',
        headers: { 'X-Candidate-Key': keyB },
        body: fdBurst
      });
      if (burstRes.status === 429) {
        const bJson = await burstRes.json();
        if (bJson.code === 'VOICE_UPLOAD_RATE_LIMITED') {
          sawIpRateLimit = true;
          break;
        }
      }
    }
    assert(sawIpRateLimit, 'Burst voice uploads must trigger 429 VOICE_UPLOAD_RATE_LIMITED');

    console.log('ALL_V22B_VOICE_PITCH_SECURITY_RETENTION_RATELIMIT_AND_CHROMIUM_E2E_PASSED');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (srv && srv.proc) srv.proc.kill('SIGTERM');
    if (pool) await pool.end().catch(() => {});
    await dropDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
})();
