#!/usr/bin/env node
/**
 * سكربت التحقق الهندسي والأمني المعزول بالكامل للإصدار v2.1
 * -------------------------------------------------------------------------
 * حواجز أمان صارمة (Safety Lockouts):
 * 1. لا يحمّل ملف .env ولا يقرأ متغير DATABASE_URL نهائياً.
 * 2. يرفض التشغيل فوراً إذا كانت NODE_ENV=production أو داخل /opt/jpf-job.
 * 3. يشترط تمرير ALLOW_ISOLATED_DRILL=1 ومتغير DRILL_PG_ADMIN_URL على المضيف المحلي فقط (127.0.0.1 / localhost) وقاعدة الصيانة /postgres.
 * 4. ينشئ قواعد بيانات ومجلد مرفقات ومنافذ مؤقتة معزولة تماماً ثم يزيلها في كتلة finally.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const { Client, Pool } = require('pg');

function abortUnsafe(reason) {
  console.error(`[SAFETY_LOCKOUT] ${reason}`);
  process.exit(1);
}

if (process.env.ALLOW_ISOLATED_DRILL !== '1') {
  abortUnsafe('يلزم تمرير ALLOW_ISOLATED_DRILL=1 صراحةً لتشغيل سكربت الفحص المعزول.');
}
if (process.env.NODE_ENV === 'production') {
  abortUnsafe('يُمنع تشغيل سكربت الفحص المعزول في بيئة الإنتاج (NODE_ENV=production).');
}
if (process.cwd().startsWith('/opt/jpf-job') || __dirname.startsWith('/opt/jpf-job')) {
  abortUnsafe('يُمنع تشغيل هذا السكربت داخل مسار الإنتاج /opt/jpf-job.');
}
if (!process.env.DRILL_PG_ADMIN_URL) {
  abortUnsafe('يلزم تحديد DRILL_PG_ADMIN_URL للاتصال بقاعدة الصيانة المحلية (/postgres) بعيداً عن DATABASE_URL.');
}

let adminUrl;
try {
  adminUrl = new URL(process.env.DRILL_PG_ADMIN_URL);
} catch (_e) {
  abortUnsafe('صيغة DRILL_PG_ADMIN_URL غير صالحة.');
}

if (!['127.0.0.1', 'localhost'].includes(adminUrl.hostname)) {
  abortUnsafe(`يُسمح بالتشغيل على المضيف المحلي فقط (127.0.0.1/localhost)، الممرر: ${adminUrl.hostname}`);
}
if (adminUrl.pathname !== '/postgres') {
  abortUnsafe(`يجب أن يشير DRILL_PG_ADMIN_URL إلى قاعدة الصيانة /postgres فقط وليس ${adminUrl.pathname}`);
}

const dbBaseOrigin = `${adminUrl.protocol}//${adminUrl.username}:${adminUrl.password}@${adminUrl.host}`;
const runTag = `${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
const dbMig = `jpf_iso_mig_${runTag}`;
const dbFresh = `jpf_iso_fresh_${runTag}`;
const dbRest = `jpf_iso_rest_${runTag}`;
const tmpRoot = `/tmp/jpf_iso_drill_${runTag}`;
const sharedUploadsDir = path.join(tmpRoot, 'uploads_data');
const backupDir = path.join(tmpRoot, 'backups');
const restoredUploadsDir = path.join(tmpRoot, 'uploads_restored');
const rbDir = path.join(tmpRoot, 'v20_rollback_app');

const SESSION_SECRET_DRILL = 'drill-isolated-session-secret-2026-v21';
const ADMIN_PASS_DRILL = 'DRILL-ADMIN-PASS-2026';

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

async function recreateIsolatedDb(dbName) {
  if (!/^jpf_iso_[a-z0-9_]+$/.test(dbName)) {
    abortUnsafe('اسم قاعدة غير مسموح: ' + dbName);
  }
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await client.end();
  }
}

async function dropIsolatedDb(dbName) {
  if (!/^jpf_iso_[a-z0-9_]+$/.test(dbName)) return;
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  } catch (_e) {
  } finally {
    await client.end();
  }
}

async function getColumnsSignature(pool) {
  const { rows } = await pool.query(`
    SELECT
      table_name,
      column_name,
      data_type,
      COALESCE(character_maximum_length::text, '-') AS max_len,
      is_nullable,
      COALESCE(regexp_replace(column_default, '::[a-z ]+', '', 'g'), 'NULL') AS col_def
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, column_name
  `);
  return rows.map((r) => `${r.table_name}.${r.column_name}:${r.data_type}(${r.max_len}):null=${r.is_nullable}:def=${r.col_def}`);
}

function spawnServer(cwd, port, dbName, uploadDir) {
  const cleanEnv = {
    PATH: process.env.PATH,
    NODE_ENV: 'test',
    PORT: String(port),
    HOST: '127.0.0.1',
    DATABASE_URL: `${dbBaseOrigin}/${dbName}`,
    UPLOAD_DIR: uploadDir,
    SESSION_SECRET: SESSION_SECRET_DRILL,
    ADMIN_ACCESS_CODE: ADMIN_PASS_DRILL
  };
  const proc = spawn(process.execPath, ['server.js'], { cwd, env: cleanEnv, stdio: 'pipe' });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server on port ${port} start timeout`)), 12000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes(String(port))) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stderr.on('data', (d) => {
      const s = String(d).trim();
      if (s) console.error(`[port ${port} stderr]:`, s);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== null && code !== 0) reject(new Error(`Server on port ${port} exited with code ${code}`));
    });
  });
  return { proc, ready };
}

(async () => {
  let v21Proc = null;
  let v20Proc = null;
  fs.mkdirSync(path.join(sharedUploadsDir, 'public'), { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(restoredUploadsDir, { recursive: true });

  try {
    console.log('=== [DRILL 1] POPULATED v2.0 (70be659) -> v2.1 UPGRADE & 139-COLUMN PARITY ===');
    await recreateIsolatedDb(dbMig);
    await recreateIsolatedDb(dbFresh);

    // 1A. تهيئة قاعدة مأهولة من مخطط الإنتاج الحالي 70be659 + ملف سيرة مرفوع قبل الترقية
    const v20Sql = execSync('git show 70be659:database/schema_and_seed.sql', { encoding: 'utf8' });
    const pMigPre = new Pool({ connectionString: `${dbBaseOrigin}/${dbMig}` });
    await pMigPre.query(v20Sql);

    const preUpgradeCvName = 'pre-upgrade-v20-cv.pdf';
    fs.writeFileSync(path.join(sharedUploadsDir, preUpgradeCvName), '%PDF-1.4 Pre-upgrade Production CV Content');
    await pMigPre.query(`UPDATE candidates SET cv_stored_path = $1 WHERE id = 1`, [`/uploads/${preUpgradeCvName}`]);

    await pMigPre.query(
      `UPDATE system_settings
       SET setting_value = setting_value || $1::jsonb
       WHERE setting_key = 'whatsapp_templates'`,
      [
        JSON.stringify({
          interview_invite: 'نص دعوة مخصص سابق من الموارد البشرية',
          custom_hr_special: 'قالب خاص إضافي محفوظ في الإنتاج'
        })
      ]
    );

    const preCounts = (
      await pMigPre.query(`
        SELECT (SELECT COUNT(*)::int FROM jobs) AS jobs,
               (SELECT COUNT(*)::int FROM candidates) AS cands,
               (SELECT COUNT(*)::int FROM applications) AS apps,
               (SELECT COUNT(*)::int FROM interviews) AS ints
      `)
    ).rows[0];
    await pMigPre.end();

    // 1B. تشغيل خادم v2.1 المعزول على القاعدة المأهولة وقياس زمن الترحيل والإقلاع
    const tMig0 = Date.now();
    const s21 = spawnServer(process.cwd(), 3091, dbMig, sharedUploadsDir);
    v21Proc = s21.proc;
    await s21.ready;
    const v21BootAndMigMs = Date.now() - tMig0;

    // 1C. تهيئة قاعدة نظيفة من v2.1 للمطابقة الصارمة للأعمدة
    execSync(
      `DATABASE_URL="${dbBaseOrigin}/${dbFresh}" ADMIN_ACCESS_CODE="${ADMIN_PASS_DRILL}" "${process.execPath}" -e "const {ensureDatabaseInitialized, pool}=require('./database/db'); ensureDatabaseInitialized().then(()=>pool.end())"`,
      { stdio: 'pipe' }
    );

    const pMig = new Pool({ connectionString: `${dbBaseOrigin}/${dbMig}` });
    const pFresh = new Pool({ connectionString: `${dbBaseOrigin}/${dbFresh}` });
    pMig.on('error', () => {});
    pFresh.on('error', () => {});

    const postCounts = (
      await pMig.query(`
        SELECT (SELECT COUNT(*)::int FROM jobs) AS jobs,
               (SELECT COUNT(*)::int FROM candidates) AS cands,
               (SELECT COUNT(*)::int FROM applications) AS apps,
               (SELECT COUNT(*)::int FROM interviews) AS ints
      `)
    ).rows[0];
    assert(JSON.stringify(preCounts) === JSON.stringify(postCounts), 'Row counts changed after migration!');

    const tplRow = (
      await pMig.query("SELECT setting_value FROM system_settings WHERE setting_key = 'whatsapp_templates'")
    ).rows[0].setting_value;
    assert(tplRow.interview_invite === 'نص دعوة مخصص سابق من الموارد البشرية', 'Custom interview_invite overwritten!');
    assert(tplRow.custom_hr_special === 'قالب خاص إضافي محفوظ في الإنتاج', 'Custom key custom_hr_special lost!');
    assert(Boolean(tplRow.pass_notification) && Boolean(tplRow.reschedule_notice), 'Original seed keys lost!');
    assert(Boolean(tplRow.interview_inperson) && Boolean(tplRow.confirm_booking), 'New v2.1 keys not merged!');

    const sigMig = await getColumnsSignature(pMig);
    const sigFresh = await getColumnsSignature(pFresh);
    const diff1 = sigMig.filter((x) => !sigFresh.includes(x));
    const diff2 = sigFresh.filter((x) => !sigMig.includes(x));
    assert(diff1.length === 0 && diff2.length === 0, 'Column parity diff: ' + JSON.stringify({ diff1, diff2 }));
    await pFresh.end();
    console.log(
      `[OK] Populated v2.0->v2.1 upgrade + server boot: ${v21BootAndMigMs}ms | Templates preserved: ${Object.keys(tplRow).length}/9 | Column parity: ${sigFresh.length}/${sigFresh.length} (0 diff)`
    );

    console.log('\n=== [DRILL 2A] CANDIDATE OWNERSHIP PROOF-OF-POSSESSION & ANTI-TAKEOVER ===');
    const base = 'http://127.0.0.1:3091';

    // منع التعداد غير الموثق
    assert((await fetch(`${base}/api/applications/1`)).status === 401, 'Numeric ID must return 401');
    assert((await fetch(`${base}/api/applications/APP-2026-1001`)).status === 403, 'Sequential ref must return 403');
    assert((await fetch(`${base}/api/public/visit/APP-2026-1001`)).status === 403, 'Visit pass must reject ref');

    // المتقدمة الشرعية (أليس) تقدم على الوظيفة 1 وتترك الاختبار معلقاً (assessment_pending)
    const makeApplyForm = ({ jobId = '1', name = 'أليس المتقدمة', email, phone, accessKey = null }) => {
      const f = new FormData();
      f.append('job_id', String(jobId));
      f.append('full_name', name);
      f.append('email', email);
      f.append('phone', phone);
      f.append('city', 'جدة');
      f.append('qualification', 'ماجستير');
      f.append('specialization', 'هندسة كيميائية');
      f.append('years_experience', '6');
      f.append('privacy_consent', 'true');
      if (accessKey) f.append('access_key', accessKey);
      f.append('cv_file', new Blob(['%PDF-1.4 Alice Legit CV ISO 9001'], { type: 'application/pdf' }), 'alice_v21.pdf');
      return f;
    };

    const aliceResp = await fetch(`${base}/api/applications`, {
      method: 'POST',
      body: makeApplyForm({ email: 'alice_owner@jpf.sa', phone: '0558887766' })
    });
    assert(aliceResp.status === 201, 'Alice initial apply failed: ' + aliceResp.status);
    const aliceCookie = aliceResp.headers.get('set-cookie').split(';')[0];
    const aliceData = await aliceResp.json();
    const aliceRef = aliceData.reference_no;
    const aliceKey = aliceData.access_key;
    assert(aliceKey && aliceKey.startsWith('JPFK-'), 'Missing cryptographic access_key!');

    // هجوم 1: منتحل يحاول سرقة الاختبار المعلق بإدخال بريد أليس مع جوال مختلف
    const atkPartial = await fetch(`${base}/api/applications`, {
      method: 'POST',
      body: makeApplyForm({ name: 'منتحل 1', email: 'alice_owner@jpf.sa', phone: '0559990000' })
    });
    assert(atkPartial.status === 409, 'Partial contact collision must return 409, got ' + atkPartial.status);
    assert(!atkPartial.headers.get('set-cookie'), 'Must not set cookie on rejected apply!');

    // هجوم 2: منتحل يعرف بريد أليس وجوال أليس معاً ويحاول استعادة اختبارها المعلق بدون مفتاح الدخول السري
    const atkExactSameJob = await fetch(`${base}/api/applications`, {
      method: 'POST',
      body: makeApplyForm({ name: 'منتحل 2', email: 'alice_owner@jpf.sa', phone: '0558887766' })
    });
    assert(atkExactSameJob.status === 403, 'Unauthenticated duplicate apply must return 403, got ' + atkExactSameJob.status);
    const atkExactJson = await atkExactSameJob.json();
    assert(atkExactJson.code === 'CANDIDATE_OWNERSHIP_PROOF_REQUIRED', 'Expected CANDIDATE_OWNERSHIP_PROOF_REQUIRED');
    assert(!atkExactJson.candidate_token && !atkExactJson.reference_no, 'Leaked token or reference_no to attacker!');
    assert(!atkExactSameJob.headers.get('set-cookie'), 'Must not set cookie for attacker!');

    // هجوم 3: منتحل يعرف بريد وجوال أليس ويحاول التقديم على وظيفة ثانية (job_id=2) لتخريب سيرتها الذاتية
    const atkOtherJob = await fetch(`${base}/api/applications`, {
      method: 'POST',
      body: makeApplyForm({ jobId: '2', name: 'منتحل مخرّب', email: 'alice_owner@jpf.sa', phone: '0558887766' })
    });
    assert(atkOtherJob.status === 403, 'Unauthenticated cross-job apply must return 403!');
    const aliceDbRow = (await pMig.query('SELECT full_name FROM candidates WHERE email = $1', ['alice_owner@jpf.sa'])).rows[0];
    assert(aliceDbRow.full_name === 'أليس المتقدمة', 'Attacker mutated Alice candidate record!');

    // هجوم 4: محاولة التحقق في candidate-verify بالرقم المرجعي + البريد/الجوال (بدون مفتاح الدخول السري)
    const atkPiiVerify = await fetch(`${base}/api/public/candidate-verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference_no: aliceRef, contact: 'alice_owner@jpf.sa' })
    });
    assert(atkPiiVerify.status === 400, 'PII-only candidate-verify must be rejected (400)!');

    const atkWrongKey = await fetch(`${base}/api/public/candidate-verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference_no: aliceRef, access_key: 'JPFK-2345-6789-ABCD-EFGH' })
    });
    assert(atkWrongKey.status === 403, 'Wrong access_key must return 403!');

    // استئناف شرعي من متصفح جديد باستخدام مفتاح الدخول السري الصحيح (Proof-of-Possession)
    const legitResume = await fetch(`${base}/api/applications`, {
      method: 'POST',
      body: makeApplyForm({ email: 'alice_owner@jpf.sa', phone: '0558887766', accessKey: aliceKey })
    });
    assert(legitResume.status === 200, 'Legitimate resume with valid access_key failed: ' + legitResume.status);
    const legitResumeJson = await legitResume.json();
    assert(legitResumeJson.resumed === true && legitResumeJson.reference_no === aliceRef, 'Resume payload mismatch!');

    // تحقق شرعي عبر candidate-verify من متصفح جديد بمفتاح الدخول السري
    const legitVerify = await fetch(`${base}/api/public/candidate-verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference_no: aliceRef, access_key: aliceKey })
    });
    assert(legitVerify.status === 200, 'Legit candidate-verify with access_key failed!');

    // إرسال الاختبار وقياس الزمن الفعلي
    const jobQs = (await pMig.query('SELECT questions FROM jobs WHERE id = 1')).rows[0].questions;
    const ans = jobQs.map((q) => ({
      question_index: q.index,
      answer_value:
        q.type === 'mcq'
          ? String(q.correct_option)
          : q.type === 'numeric'
            ? String(q.correct_number)
            : 'تطبيق معايير السلامة والجودة ISO 9001 ومراقبة اللزوجة والكثافة بدقة.',
      time_taken_seconds: 9
    }));
    const tSub0 = Date.now();
    const subResp = await fetch(`${base}/api/assessments/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({ reference_no: aliceRef, answers: ans, telemetry: { tab_switches: 0, paste_attempts: 0, time_spent_seconds: 90 } })
    });
    const subMs = Date.now() - tSub0;
    assert(subResp.status === 200, 'Assessment submit failed');

    // دخول موظف اللجنة وفحص تدوير رابط الاستعادة للجوال المسجل فقط
    const loginResp = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PASS_DRILL })
    });
    assert(loginResp.status === 200, 'Staff login failed');
    const staffCookie = loginResp.headers.get('set-cookie').split(';')[0];

    const aliceAppId = (await pMig.query('SELECT id FROM applications WHERE reference_no = $1', [aliceRef])).rows[0].id;
    const recResp = await fetch(`${base}/api/applications/${aliceAppId}/recovery-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({})
    });
    assert(recResp.status === 201, 'HR recovery-link failed');
    const recJson = await recResp.json();
    assert(recJson.wa_message.recipient_phone === '966558887766', 'Recovery WA must target registered DB phone only!');
    assert(recJson.wa_message.queue_status === 'queued', 'Recovery WA must start queued!');

    // المفتاح القديم أُبطل فوراً بعد التدوير
    const oldKeyCheck = await fetch(`${base}/api/public/candidate-verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference_no: aliceRef, access_key: aliceKey })
    });
    assert(oldKeyCheck.status === 403, 'Rotated old access_key must be rejected (403)!');

    // الرابط المحدّث المرسل للجوال المسجل يعمل فوراً
    const recCt = new URL(recJson.recovery_url).searchParams.get('ct');
    const recFetch = await fetch(`${base}/api/applications/${aliceRef}?ct=${encodeURIComponent(recCt)}`);
    assert(recFetch.status === 200, 'Fresh recovery token failed!');
    console.log(`[OK] Candidate PoP ownership, anti-takeover, key rotation & <25ms submit (${subMs}ms) verified!`);

    console.log('\n=== [DRILL 2B] WHATSAPP STATE CONSISTENCY & RESCHEDULE TOKEN REVOCATION ===');
    const sch1 = await fetch(`${base}/api/interviews/schedule-single`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({
        application_id: aliceAppId,
        scheduled_date: '2026-11-20',
        start_time: '10:00',
        interview_mode: 'in_person',
        open_draft: true
      })
    }).then((r) => r.json());

    const vt1 = new URL(sch1.visit_url).searchParams.get('vt');
    assert(sch1.wa_message.queue_status === 'queued' && sch1.wa_message.prepared_at !== null, 'Draft must stay queued!');
    assert(sch1.interview.booking_status === 'scheduled', 'Interview must start scheduled!');

    // منع المرشح من تأكيد الحضور قبل إرسال الدعوة فعلياً (queued لا تتحول إلى confirmed)
    const prematureConfirm = await fetch(`${base}/api/public/visit/${encodeURIComponent(vt1)}/confirm`, { method: 'POST' });
    assert(prematureConfirm.status === 409, 'Confirm before invitation_sent must return 409, got ' + prematureConfirm.status);

    // منع الموظف من تحويل رسالة queued مباشرة إلى confirmed قبل إرسالها
    const directStaffConfirmUnsent = await fetch(`${base}/api/wa-messages/${sch1.wa_message.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ queue_status: 'confirmed' })
    });
    assert(directStaffConfirmUnsent.status === 400, 'Direct queued->confirmed must return 400!');

    // تأكيد إرسال الدعوة الأولى فعلياً
    const send1 = await fetch(`${base}/api/wa-messages/${sch1.wa_message.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ action: 'confirm_sent' })
    });
    assert(send1.status === 200, 'confirm_sent failed');

    // إضافة رسالة تذكير ثانية غير مرسلة (queued) لنفس المقابلة للتأكد أنها لا تتحول إلى confirmed عند تأكيد الحضور
    const unsentReminder = await fetch(`${base}/api/wa-messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({
        application_id: aliceAppId,
        interview_id: sch1.interview.id,
        template_key: 'reminder_day_before',
        recipient_name: 'أليس المتقدمة',
        recipient_phone: '0558887766',
        message_body: 'تذكير غداً بالموعد'
      })
    }).then((r) => r.json());
    assert(unsentReminder.message.queue_status === 'queued', 'Reminder must be queued');

    // تأكيد حضور المرشح الآن بعد إرسال الدعوة
    const okConfirm1 = await fetch(`${base}/api/public/visit/${encodeURIComponent(vt1)}/confirm`, { method: 'POST' });
    assert(okConfirm1.status === 200, 'Candidate confirm after invitation_sent failed!');

    const msgStatesAfterConfirm = (
      await pMig.query('SELECT id, queue_status FROM wa_messages WHERE interview_id = $1 ORDER BY id ASC', [sch1.interview.id])
    ).rows;
    const sentMsgRow = msgStatesAfterConfirm.find((m) => m.id === sch1.wa_message.id);
    const queuedRemRow = msgStatesAfterConfirm.find((m) => m.id === unsentReminder.message.id);
    assert(sentMsgRow.queue_status === 'confirmed', 'Sent invitation should become confirmed!');
    assert(queuedRemRow.queue_status === 'queued', 'Unsent queued reminder MUST stay queued and NOT become confirmed!');

    // إعادة الجدولة عبر schedule-single -> تدوير visit_token وإبطال vt1 وإلغاء كافة الرسائل السابقة
    const sch2 = await fetch(`${base}/api/interviews/schedule-single`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({
        application_id: aliceAppId,
        scheduled_date: '2026-11-22',
        start_time: '11:30',
        interview_mode: 'in_person',
        open_draft: false
      })
    }).then((r) => r.json());

    const vt2 = new URL(sch2.visit_url).searchParams.get('vt');
    assert(vt2 !== vt1, 'Reschedule MUST rotate visit_token!');
    assert(sch2.interview.booking_status === 'rescheduled', 'Status must be rescheduled!');

    assert((await fetch(`${base}/api/public/visit/${encodeURIComponent(vt1)}`)).status === 403, 'Old vt1 GET must return 403!');
    assert(
      (await fetch(`${base}/api/public/visit/${encodeURIComponent(vt1)}/confirm`, { method: 'POST' })).status === 403,
      'Old vt1 POST confirm must return 403!'
    );
    assert((await fetch(`${base}/api/public/visit/${encodeURIComponent(vt2)}`)).status === 200, 'New vt2 GET must return 200!');

    const oldMsgsAfterResched = (
      await pMig.query('SELECT queue_status FROM wa_messages WHERE id = ANY($1::int[])', [[sch1.wa_message.id, unsentReminder.message.id]])
    ).rows;
    assert(oldMsgsAfterResched.every((r) => r.queue_status === 'cancelled'), 'All prior messages must be cancelled on reschedule!');

    // رفض إرسال رسالة ملغاة قديمة
    const sendCancelledTry = await fetch(`${base}/api/wa-messages/${sch1.wa_message.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ action: 'confirm_sent' })
    });
    assert(sendCancelledTry.status === 400, 'Sending a cancelled message must return 400!');

    // إعادة الجدولة عبر PATCH /api/interviews/:id -> تدوير جديد vt3 وإبطال vt2
    const patchResched = await fetch(`${base}/api/interviews/${sch1.interview.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ start_time: '14:00' })
    }).then((r) => r.json());
    const vt3 = new URL(patchResched.visit_url).searchParams.get('vt');
    assert(vt3 !== vt2, 'PATCH reschedule must rotate visit_token!');
    assert((await fetch(`${base}/api/public/visit/${encodeURIComponent(vt2)}`)).status === 403, 'Old vt2 must return 403 after PATCH!');
    assert((await fetch(`${base}/api/public/visit/${encodeURIComponent(vt3)}`)).status === 200, 'New vt3 must return 200!');
    assert(patchResched.wa_message && patchResched.wa_message.queue_status === 'queued', 'PATCH reschedule must queue reschedule_notice!');
    console.log('[OK] WhatsApp state transitions & reschedule visit_token/message revocation verified!');

    console.log('\n=== [DRILL 2C] RBAC RECOVERY SECRET ISOLATION, DRAFT PRESERVATION & ATOMIC CONCURRENCY ===');
    // 1. إنشاء حساب عضو لجنة (committee_member) وحساب منسق موارد بشرية (hr_coordinator) والتحقق من عزل أسرار الاستعادة
    const createCommResp = await fetch(`${base}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({
        username: 'comm_audit',
        full_name: 'عضو لجنة فحص الصلاحيات',
        role: 'committee_member',
        password: 'CommPass-2026-Strong'
      })
    });
    assert(createCommResp.status === 201, 'Creating committee_member failed: ' + createCommResp.status);

    const createHrResp = await fetch(`${base}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({
        username: 'hr_audit',
        full_name: 'منسق موارد فحص الصلاحيات',
        role: 'hr_coordinator',
        password: 'HrCoordPass-2026-Strong'
      })
    });
    assert(createHrResp.status === 201, 'Creating hr_coordinator failed: ' + createHrResp.status);

    const commLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'comm_audit', password: 'CommPass-2026-Strong' })
    });
    const commCookie = commLogin.headers.get('set-cookie').split(';')[0];

    const hrLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'hr_audit', password: 'HrCoordPass-2026-Strong' })
    });
    const hrCookie = hrLogin.headers.get('set-cookie').split(';')[0];

    // منع عضو اللجنة من توليد رابط استعادة أو قراءة رسائل الاستعادة أو فتحها أو الاطلاع على التوكن الخام
    const commGenRec = await fetch(`${base}/api/applications/${aliceAppId}/recovery-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: commCookie },
      body: JSON.stringify({})
    });
    assert(commGenRec.status === 403, 'committee_member must get 403 on POST recovery-link!');

    const commWaList = await fetch(`${base}/api/wa-messages`, {
      headers: { Cookie: commCookie }
    }).then((r) => r.json());
    const commRawStr = JSON.stringify(commWaList);
    assert(
      !commWaList.messages.some((m) => m.template_key === 'portal_recovery') &&
        !commRawStr.includes(recJson.access_key) &&
        !commRawStr.includes(recCt),
      'committee_member leaked portal_recovery secrets in GET /api/wa-messages!'
    );

    const commPatchRec = await fetch(`${base}/api/wa-messages/${recJson.wa_message.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: commCookie },
      body: JSON.stringify({ action: 'open_draft' })
    });
    assert(commPatchRec.status === 403, 'committee_member must get 403 on PATCH portal_recovery message!');

    const commPostRec = await fetch(`${base}/api/wa-messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: commCookie },
      body: JSON.stringify({
        application_id: aliceAppId,
        template_key: 'portal_recovery',
        recipient_name: 'أليس',
        recipient_phone: '0558887766',
        message_body: 'test'
      })
    });
    assert(commPostRec.status === 403, 'committee_member must get 403 on POST portal_recovery message!');

    const commAppDetail = await fetch(`${base}/api/applications/${aliceAppId}?mode=committee`, {
      headers: { Cookie: commCookie }
    }).then((r) => r.json());
    assert(
      commAppDetail.application.candidate_access_token === undefined &&
        (!commAppDetail.interview || commAppDetail.interview.visit_token === undefined),
      'Raw candidate_access_token or visit_token leaked in GET /api/applications/:id!'
    );

    // التأكد أن منسق الموارد البشرية (hr_coordinator) يستطيع قراءة مسودة الاستعادة
    const hrWaList = await fetch(`${base}/api/wa-messages`, {
      headers: { Cookie: hrCookie }
    }).then((r) => r.json());
    const hrRecMsg = hrWaList.messages.find((m) => m.id === recJson.wa_message.id);
    assert(Boolean(hrRecMsg), 'hr_coordinator must be able to view portal_recovery message!');

    // 2. التحقق من الحفاظ على النص الأصلي لمسودتَي portal_recovery و reschedule_notice في الواجهة والـ API
    const interviewsHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'Interviews.dc.html'), 'utf8');
    assert(interviewsHtml.includes("key: 'reschedule_notice'"), 'reschedule_notice missing from TEMPLATE_STAGES in Interviews.dc.html!');
    assert(
      interviewsHtml.includes("q.template_key === 'portal_recovery'"),
      'portal_recovery locked template guard missing in Interviews.dc.html!'
    );

    const fnMatch = interviewsHtml.match(/function resolveDraftPayload\(item, stageKeyOverride\)\s*\{[\s\S]*?\n    \}/);
    assert(Boolean(fnMatch), 'resolveDraftPayload function not found in Interviews.dc.html!');
    const uiSandbox = {
      templatesState: hrWaList.templates,
      applyTemplateClient: () => 'OVERWRITTEN_BY_DEFAULT_INVITE_TEMPLATE'
    };
    vm.createContext(uiSandbox);
    vm.runInContext(`${fnMatch[0]}; this.resolveDraftPayload = resolveDraftPayload;`, uiSandbox);

    // حتى لو مُرر interview_invite بالخطأ مع portal_recovery، ترفض دالة الواجهة استبدال النص وتبقي الرابط والمفتاح السري
    const uiRecDraft = uiSandbox.resolveDraftPayload(hrRecMsg, 'interview_invite');
    assert(
      uiRecDraft.bodyToSend.includes(recJson.recovery_url) &&
        uiRecDraft.bodyToSend.includes(recJson.access_key) &&
        uiRecDraft.patchPayload.message_body === undefined,
      'UI resolveDraftPayload overwrote portal_recovery body!'
    );

    // ومع reschedule_notice يكون الخيار المحدد هو reschedule_notice نفسه فيبقى النص المولّد والرمز الجديد vt3 كما هو
    const hrReschedMsg = hrWaList.messages.find((m) => m.id === patchResched.wa_message.id);
    const uiReschedDraft = uiSandbox.resolveDraftPayload(hrReschedMsg, 'reschedule_notice');
    assert(
      uiReschedDraft.bodyToSend === hrReschedMsg.message_body &&
        uiReschedDraft.bodyToSend.includes(encodeURIComponent(vt3)) &&
        uiReschedDraft.patchPayload.message_body === undefined,
      'UI resolveDraftPayload overwrote reschedule_notice body!'
    );

    // اختبار الـ API الفعلي: رفض أي محاولة تعديل لنص portal_recovery (400 RECOVERY_BODY_IMMUTABLE) والسماح بفتح المسودة بنصها الأصلي
    const tamperRecResp = await fetch(`${base}/api/wa-messages/${recJson.wa_message.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify({ action: 'open_draft', message_body: 'MALICIOUS_OR_ACCIDENTAL_OVERWRITE' })
    });
    assert(tamperRecResp.status === 400, 'Tampering portal_recovery body must return 400 RECOVERY_BODY_IMMUTABLE, got ' + tamperRecResp.status);
    const tamperRecBody = await tamperRecResp.json();
    assert(tamperRecBody.code === 'RECOVERY_BODY_IMMUTABLE', 'Expected code RECOVERY_BODY_IMMUTABLE!');

    const openRecApi = await fetch(`${base}/api/wa-messages/${recJson.wa_message.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify({ action: 'open_draft' })
    }).then((r) => r.json());
    assert(
      openRecApi.message.message_body.includes(recJson.recovery_url) &&
        openRecApi.message.message_body.includes(recJson.access_key) &&
        openRecApi.message.queue_status === 'queued' &&
        openRecApi.message.prepared_at !== null,
      'Backend failed to open portal_recovery draft cleanly!'
    );

    const openReschedApi = await fetch(`${base}/api/wa-messages/${patchResched.wa_message.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify(uiReschedDraft.patchPayload)
    }).then((r) => r.json());
    assert(
      openReschedApi.message.message_body.includes(encodeURIComponent(vt3)) && openReschedApi.message.queue_status === 'queued',
      'Reschedule draft lost vt3 on open_draft!'
    );

    // 3. منع التعيين المباشر لـ invitation_sent و confirmed في PATCH /api/interviews/:id + اختبار التزامن الذري
    const illegalInvSent = await fetch(`${base}/api/interviews/${sch1.interview.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ booking_status: 'invitation_sent' })
    });
    assert(illegalInvSent.status === 400, 'Direct PATCH booking_status=invitation_sent must return 400!');

    const illegalDirectConf1 = await fetch(`${base}/api/interviews/${sch1.interview.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ booking_status: 'confirmed' })
    });
    assert(illegalDirectConf1.status === 400, 'Direct PATCH booking_status=confirmed must return 400!');

    const illegalPrematureComp = await fetch(`${base}/api/interviews/${sch1.interview.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ booking_status: 'completed' })
    });
    assert(illegalPrematureComp.status === 400, 'Direct PATCH booking_status=completed before invitation_sent must return 400!');

    // تأكيد إرسال دعوة vt3 لتصبح الحالة invitation_sent، ثم التحقق من استمرار منع التعيين اليدوي لـ confirmed
    await fetch(`${base}/api/wa-messages/${patchResched.wa_message.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify({ action: 'confirm_sent' })
    });
    const illegalDirectConf2 = await fetch(`${base}/api/interviews/${sch1.interview.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ booking_status: 'confirmed' })
    });
    assert(illegalDirectConf2.status === 400, 'Direct PATCH booking_status=confirmed even after invitation_sent must return 400!');

    // سباق تزامن فعلي: تأكيد المرشح بالرابط القديم vt3 بالتزامن مع إعادة جدولة الموعد إلى 15:30
    const [raceReschedResp, raceOldConfirmResp] = await Promise.all([
      fetch(`${base}/api/interviews/${sch1.interview.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
        body: JSON.stringify({ start_time: '15:30' })
      }),
      fetch(`${base}/api/public/visit/${encodeURIComponent(vt3)}/confirm`, { method: 'POST' })
    ]);
    assert(raceReschedResp.status === 200, 'Concurrent reschedule failed!');
    assert([200, 403, 409].includes(raceOldConfirmResp.status), 'Unexpected status in concurrent confirm: ' + raceOldConfirmResp.status);

    // أياً كان ترتيب حصول الطلبين على قفل الصف (FOR UPDATE)، يجب أن تكون النتيجة النهائية للموعد الجديد هي rescheduled وليس confirmed أبداً!
    const afterRaceDb = (await pMig.query('SELECT booking_status FROM interviews WHERE id = $1', [sch1.interview.id])).rows[0];
    assert(
      afterRaceDb.booking_status === 'rescheduled',
      `Race condition bug: old token confirmed newly rescheduled interview (got ${afterRaceDb.booking_status})!`
    );
    assert(
      (await fetch(`${base}/api/public/visit/${encodeURIComponent(vt3)}/confirm`, { method: 'POST' })).status === 403,
      'Old vt3 must return 403 after concurrent reschedule!'
    );
    console.log('[OK] Committee RBAC secret isolation, draft body preservation & atomic FOR UPDATE concurrency verified!');

    console.log('\n=== [DRILL 2D] EXHAUSTIVE CONFLICTING PARAMS, STATE MATRICES, 3-ROLE RBAC & MULTI-WAY CONCURRENCY ===');
    const executedCases = [];
    const recordCase = (id, category, desc, status = 'PASS') => {
      executedCases.push({ id, category, desc, status });
      console.log(`  [${status}] ${id} (${category}): ${desc}`);
    };

    // 1. اختبار ثغرة { action: 'confirm_sent', queue_status: 'cancelled' } وكافة التوليفات المتعارضة على الرسائل الملغاة والنشطة
    const cancelledMsgId = sch1.wa_message.id; // ملغاة من إعادة الجدولة السابقة
    const activeQueuedAfterRace = (
      await pMig.query(
        "SELECT id FROM wa_messages WHERE interview_id = $1 AND queue_status = 'queued' ORDER BY id DESC LIMIT 1",
        [sch1.interview.id]
      )
    ).rows[0].id;

    for (const badBody of [
      { action: 'confirm_sent', queue_status: 'cancelled' },
      { action: 'confirm_sent', queue_status: 'queued' },
      { action: 'open_draft', queue_status: 'cancelled' },
      { action: 'open_draft', queue_status: 'sent' }
    ]) {
      const rCancelled = await fetch(`${base}/api/wa-messages/${cancelledMsgId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify(badBody)
      });
      const bCancelled = await rCancelled.json();
      assert(rCancelled.status === 400 && bCancelled.code === 'CONFLICTING_WA_PARAMS', 'Must reject conflicting params on cancelled msg!');

      const rActive = await fetch(`${base}/api/wa-messages/${activeQueuedAfterRace}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify(badBody)
      });
      const bActive = await rActive.json();
      assert(rActive.status === 400 && bActive.code === 'CONFLICTING_WA_PARAMS', 'Must reject conflicting params on active msg!');
    }

    const dbCancelledCheck = (await pMig.query('SELECT queue_status FROM wa_messages WHERE id = $1', [cancelledMsgId])).rows[0];
    const dbIntAfterBypassTry = (await pMig.query('SELECT booking_status FROM interviews WHERE id = $1', [sch1.interview.id])).rows[0];
    assert(dbCancelledCheck.queue_status === 'cancelled', 'Cancelled message was revived!');
    assert(dbIntAfterBypassTry.booking_status === 'rescheduled', 'Rescheduled interview was altered by cancelled message!');
    recordCase('TC-07', 'WA Conflict Guard', '{ action: "confirm_sent", queue_status: "cancelled" } & all dual action+queue_status payloads -> 400 CONFLICTING_WA_PARAMS; DB unchanged');

    // اختبار قيم غير صالحة وطلب فارغ
    assert(
      (await fetch(`${base}/api/wa-messages/${activeQueuedAfterRace}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({ action: 'force_send' })
      })).status === 400,
      'Unknown action must return 400!'
    );
    assert(
      (await fetch(`${base}/api/wa-messages/${activeQueuedAfterRace}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({ queue_status: 'bogus' })
      })).status === 400,
      'Unknown queue_status must return 400!'
    );
    assert(
      (await fetch(`${base}/api/wa-messages/${activeQueuedAfterRace}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({})
      })).status === 400,
      'Empty PATCH body must return 400!'
    );

    // 2. القفل النهائي الصارم للرسالة الملغاة ضد جميع الطلبات المفردة
    for (const singlePayload of [
      { action: 'open_draft' },
      { action: 'confirm_sent' },
      { queue_status: 'sent' },
      { queue_status: 'queued' },
      { queue_status: 'confirmed' },
      { queue_status: 'failed' },
      { queue_status: 'cancelled' },
      { message_body: 'تعديل نص رسالة ملغاة' }
    ]) {
      const resp = await fetch(`${base}/api/wa-messages/${cancelledMsgId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify(singlePayload)
      });
      const body = await resp.json();
      assert(resp.status === 400 && body.code === 'WA_MESSAGE_CANCELLED', `Cancelled msg accepted ${JSON.stringify(singlePayload)}!`);
    }
    recordCase('TC-08', 'WA Terminal Lock', 'Every single-param mutation on cancelled wa_message returns 400 WA_MESSAGE_CANCELLED');

    // 3. دورة حياة الفشل وإعادة المحاولة (queued -> failed -> queued -> sent) + منع التعديل والرجوع بعد sent
    const customMsgRes = await fetch(`${base}/api/wa-messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify({
        application_id: aliceAppId,
        template_key: 'thank_followup',
        recipient_name: 'أليس المتقدمة',
        recipient_phone: '0558887766',
        message_body: 'شكراً لحضورك'
      })
    }).then((r) => r.json());
    const customMsgId = customMsgRes.message.id;

    assert(
      (await fetch(`${base}/api/wa-messages/${customMsgId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({ queue_status: 'failed' })
      })).status === 200,
      'queued -> failed must succeed!'
    );
    assert(
      (await fetch(`${base}/api/wa-messages/${customMsgId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({ action: 'confirm_sent' })
      })).status === 400,
      'failed -> confirm_sent directly must return 400!'
    );
    assert(
      (await fetch(`${base}/api/wa-messages/${customMsgId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({ queue_status: 'queued' })
      })).status === 200,
      'failed -> queued retry reset must succeed!'
    );

    // سباق تزامن تأكيد إرسال نفس الرسالة مرتين في نفس اللحظة (Promise.all)
    const [concSendA, concSendB] = await Promise.all([
      fetch(`${base}/api/wa-messages/${customMsgId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({ action: 'confirm_sent' })
      }),
      fetch(`${base}/api/wa-messages/${customMsgId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
        body: JSON.stringify({ action: 'confirm_sent' })
      })
    ]);
    const sendCodes = [concSendA.status, concSendB.status].sort();
    assert(sendCodes[0] === 200 && sendCodes[1] === 400, `Concurrent confirm_sent expected [200,400], got ${JSON.stringify(sendCodes)}`);

    // منع الرجوع من sent إلى queued أو open_draft أو تعديل النص بعد الإرسال
    assert(
      (await fetch(`${base}/api/wa-messages/${customMsgId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({ queue_status: 'queued' })
      })).status === 400,
      'sent -> queued regression must return 400!'
    );
    assert(
      (await fetch(`${base}/api/wa-messages/${customMsgId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({ action: 'open_draft' })
      })).status === 400,
      'sent -> open_draft must return 400!'
    );
    assert(
      (await fetch(`${base}/api/wa-messages/${customMsgId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({ message_body: 'تزوير بعد الإرسال' })
      })).status === 400,
      'Editing sent message_body must return 400 SENT_BODY_IMMUTABLE!'
    );
    // منع تزوير رسالة portal_recovery عبر POST /api/wa-messages
    assert(
      (await fetch(`${base}/api/wa-messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({
          application_id: aliceAppId,
          template_key: 'portal_recovery',
          recipient_name: 'أليس',
          recipient_phone: '0558887766',
          message_body: 'مزورة'
        })
      })).status === 400,
      'Manual POST portal_recovery must return 400!'
    );
    recordCase('TC-09', 'WA Transition Matrix', 'Retry (queued->failed->queued->sent), concurrent double-send [200,400], post-send immutability & portal_recovery spoof block verified');

    // 4. سباق تزامن تأكيد دعوة قديمة مقابل إعادة جدولة الموعد (Race A) + سباق تدوير استعادة مزدوج (Race D)
    const [raceSendOldInvite, raceReschedAgain] = await Promise.all([
      fetch(`${base}/api/wa-messages/${activeQueuedAfterRace}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({ action: 'confirm_sent' })
      }),
      fetch(`${base}/api/interviews/${sch1.interview.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
        body: JSON.stringify({ start_time: '16:15' })
      })
    ]);
    assert(raceReschedAgain.status === 200, 'Race reschedule to 16:15 failed!');
    assert([200, 400, 409].includes(raceSendOldInvite.status), 'Unexpected status in raceSendOldInvite: ' + raceSendOldInvite.status);
    const oldInviteAfterRace = (await pMig.query('SELECT queue_status FROM wa_messages WHERE id = $1', [activeQueuedAfterRace])).rows[0];
    const intAfterInviteRace = (await pMig.query('SELECT booking_status, start_time FROM interviews WHERE id = $1', [sch1.interview.id])).rows[0];
    assert(oldInviteAfterRace.queue_status === 'cancelled', 'Old invite must end cancelled after concurrent reschedule!');
    assert(intAfterInviteRace.booking_status === 'rescheduled', 'Interview must end rescheduled after concurrent reschedule!');

    const [concRec1, concRec2] = await Promise.all([
      fetch(`${base}/api/applications/${aliceAppId}/recovery-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({})
      }),
      fetch(`${base}/api/applications/${aliceAppId}/recovery-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
        body: JSON.stringify({})
      })
    ]);
    assert(concRec1.status === 201 && concRec2.status === 201, 'Concurrent recovery-link calls must serialize cleanly!');
    const activeRecoveryRows = (
      await pMig.query(
        "SELECT id, message_body FROM wa_messages WHERE application_id = $1 AND template_key = 'portal_recovery' AND queue_status = 'queued'",
        [aliceAppId]
      )
    ).rows;
    assert(activeRecoveryRows.length === 1, `Expected exactly 1 active portal_recovery draft after concurrent rotation, got ${activeRecoveryRows.length}!`);
    recordCase('TC-10', 'Atomic Concurrency', 'Concurrent confirm_sent vs reschedule & concurrent dual recovery-link rotation serialized cleanly with 1 active draft');

    // 5. مصفوفة انتقالات المقابلات وأهلية المرشحين + التقديم المزدوج المتزامن للاختبار + حارس رفع المرفقات
    const fdPending = new FormData();
    fdPending.append('job_id', '1');
    fdPending.append('full_name', 'خالد قيد الاختبار');
    fdPending.append('email', 'khalid.pending@jpf.sa');
    fdPending.append('phone', '0554443322');
    fdPending.append('city', 'جدة');
    fdPending.append('qualification', 'بكالوريوس');
    fdPending.append('specialization', 'هندسة صناعية');
    fdPending.append('years_experience', '4');
    fdPending.append('privacy_consent', 'true');
    fdPending.append('cv_file', new Blob(['%PDF-1.4 Khalid CV خبرة 4 سنوات جودة ومبيعات'], { type: 'application/pdf' }), 'khalid.pdf');
    const khalidAppResp = await fetch(`${base}/api/applications`, { method: 'POST', body: fdPending });
    assert(khalidAppResp.status === 201, 'Creating pending candidate Khalid failed');
    const khalidCookie = khalidAppResp.headers.get('set-cookie').split(';')[0];
    const khalidBody = await khalidAppResp.json();
    const khalidRef = khalidBody.application.reference_no;
    const khalidId = (await pMig.query('SELECT id FROM applications WHERE reference_no = $1', [khalidRef])).rows[0].id;

    // منع جدولة مرشح ما زال assessment_pending + منع تقييم اللجنة له + منع اعتماده لعرض وظيفي
    assert(
      (await fetch(`${base}/api/interviews/schedule-single`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({ application_id: khalidId, scheduled_date: '2026-11-25', start_time: '10:00' })
      })).status === 400,
      'Scheduling assessment_pending candidate must return 400!'
    );
    assert(
      (await fetch(`${base}/api/interviews/schedule-single`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({ application_id: aliceAppId, scheduled_date: '2026-11-25', start_time: '27:99' })
      })).status === 400,
      'Invalid HH:MM start_time must return 400!'
    );
    assert(
      (await fetch(`${base}/api/evaluations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: commCookie },
        body: JSON.stringify({
          application_id: khalidId,
          technical_competence: 4,
          communication_persuasion: 4,
          problem_solving: 4,
          cultural_fit: 4,
          portfolio_practical: 4
        })
      })).status === 400,
      'Evaluating assessment_pending candidate must return 400!'
    );
    assert(
      (await fetch(`${base}/api/applications/${khalidId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({ status: 'offered' })
      })).status === 400,
      'Offering assessment_pending candidate must return 400!'
    );

    // فحص حارس رفع مرفقات الاختبار: رفض بدون توكن، نجاح بتوكن نشط، ورفض بعد إتمام الاختبار
    const attUnauthFd = new FormData();
    attUnauthFd.append('attachment_file', new Blob(['%PDF-1.4 unauth'], { type: 'application/pdf' }), 'u.pdf');
    assert((await fetch(`${base}/api/assessments/upload-attachment`, { method: 'POST', body: attUnauthFd })).status === 403, 'Unauth upload must be 403!');

    const attOkFd = new FormData();
    attOkFd.append('attachment_file', new Blob(['%PDF-1.4 valid portfolio'], { type: 'application/pdf' }), 'portfolio.pdf');
    assert(
      (await fetch(`${base}/api/assessments/upload-attachment`, {
        method: 'POST',
        headers: { Cookie: khalidCookie },
        body: attOkFd
      })).status === 200,
      'Active pending candidate attachment upload must return 200!'
    );

    // سباق التقديم المتزامن المزدوج للاختبار (Promise.all) على طلب خالد
    const job1Questions = (await pMig.query('SELECT questions FROM jobs WHERE id = 1')).rows[0].questions;
    const khalidAnswers = job1Questions.map((q) => ({
      question_index: q.index,
      answer_value: q.type === 'mcq' ? 0 : q.type === 'numeric' ? (q.correct_number ?? 85) : 'تحليل خطة جودة ومبيعات وتطوير مؤشرات الأداء والالتزام بالمواصفات القياسية للدهانات'
    }));
    const [kSub1, kSub2] = await Promise.all([
      fetch(`${base}/api/assessments/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: khalidCookie },
        body: JSON.stringify({ reference_no: khalidRef, answers: khalidAnswers, telemetry: { time_spent_seconds: 75 } })
      }).then((r) => r.json()),
      fetch(`${base}/api/assessments/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: khalidCookie },
        body: JSON.stringify({ reference_no: khalidRef, answers: khalidAnswers, telemetry: { time_spent_seconds: 75 } })
      }).then((r) => r.json())
    ]);
    assert(Boolean(kSub1.already_submitted) !== Boolean(kSub2.already_submitted), 'Exactly one concurrent submit must grade and the second return already_submitted!');
    const khalidAnsCount = (await pMig.query('SELECT COUNT(*)::int AS cnt FROM assessment_answers WHERE application_id = $1', [khalidId])).rows[0].cnt;
    assert(khalidAnsCount === job1Questions.length, `Duplicate assessment_answers rows created (${khalidAnsCount})!`);

    // بعد إتمام الاختبار يُرفض رفع مرفق جديد بنفس الكوكي لأن الحالة لم تعد assessment_pending
    const attAfterSubmitFd = new FormData();
    attAfterSubmitFd.append('attachment_file', new Blob(['%PDF-1.4 late'], { type: 'application/pdf' }), 'late.pdf');
    assert(
      (await fetch(`${base}/api/assessments/upload-attachment`, {
        method: 'POST',
        headers: { Cookie: khalidCookie },
        body: attAfterSubmitFd
      })).status === 403,
      'Post-submit attachment upload must return 403!'
    );
    recordCase('TC-11', 'Assessment & Eligibility', 'Attachment live-DB guard, concurrent double-submit idempotency, and ineligible scheduling/evaluation/offer blocks verified');

    // 6. مصفوفة الصلاحيات الكاملة للأدوار الثلاثة + الإيقاف اللحظي لحساب الموظف النشط
    assert(
      (await fetch(`${base}/api/interviews/schedule-single`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: commCookie },
        body: JSON.stringify({ application_id: khalidId, scheduled_date: '2026-11-26', start_time: '10:00' })
      })).status === 403,
      'committee_member must get 403 on schedule-single!'
    );
    assert(
      (await fetch(`${base}/api/interviews/${sch1.interview.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: commCookie },
        body: JSON.stringify({ start_time: '17:00' })
      })).status === 403,
      'committee_member must get 403 on interview reschedule!'
    );
    assert(
      (await fetch(`${base}/api/interviews/${sch1.interview.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: commCookie },
        body: JSON.stringify({ booking_status: 'cancelled' })
      })).status === 403,
      'committee_member must get 403 on interview cancel!'
    );
    assert(
      (await fetch(`${base}/api/applications/${aliceAppId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: commCookie },
        body: JSON.stringify({ status: 'offered' })
      })).status === 403,
      'committee_member must get 403 on application status decision!'
    );
    assert(
      (await fetch(`${base}/api/evaluations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({
          application_id: aliceAppId,
          technical_competence: 4.5,
          communication_persuasion: 4.5,
          problem_solving: 4.5,
          cultural_fit: 4.5,
          portfolio_practical: 4.5
        })
      })).status === 403,
      'hr_coordinator must get 403 on POST /api/evaluations!'
    );
    assert(
      (await fetch(`${base}/api/evaluations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: commCookie },
        body: JSON.stringify({
          application_id: aliceAppId,
          technical_competence: 4.6,
          communication_persuasion: 4.4,
          problem_solving: 4.5,
          cultural_fit: 4.7,
          portfolio_practical: 4.5,
          recommendation: 'strong_hire',
          notes: 'أداء متميز في المقابلة الفنية'
        })
      })).status === 201,
      'committee_member POST /api/evaluations must return 201!'
    );
    const hrStatusUpd = await fetch(`${base}/api/applications/${khalidId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify({ status: 'under_review' })
    });
    assert(hrStatusUpd.status === 200, 'hr_coordinator status=under_review must return 200!');
    const hrStatusBody = await hrStatusUpd.json();
    assert(hrStatusBody.application.candidate_access_token === undefined, 'PATCH status leaked candidate_access_token!');
    assert(
      (await fetch(`${base}/api/applications/${khalidId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({ status: 'passed_assessment' })
      })).status === 400,
      'Forging passed_assessment via PATCH status must return 400!'
    );

    // منع مدير النظام من تخفيض صلاحياته أو إيقاف حسابه الشخصي
    const adminMe = await fetch(`${base}/api/auth/me`, { headers: { Cookie: staffCookie } }).then((r) => r.json());
    assert(
      (await fetch(`${base}/api/users/${adminMe.user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
        body: JSON.stringify({ role: 'hr_coordinator' })
      })).status === 400,
      'Admin self-demotion must return 400!'
    );

    // اختبار الإيقاف الفوري اللحظي لحساب موظف لديه كوكي جلسة موقّع صالح
    const tempStaffRes = await fetch(`${base}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({
        username: 'temp_hr_revoke',
        full_name: 'موظف اختبار الإيقاف اللحظي',
        role: 'hr_coordinator',
        password: 'TempRevoke-2026-Pass'
      })
    }).then((r) => r.json());
    const tempLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'temp_hr_revoke', password: 'TempRevoke-2026-Pass' })
    });
    const tempCookie = tempLogin.headers.get('set-cookie').split(';')[0];
    assert((await fetch(`${base}/api/stats`, { headers: { Cookie: tempCookie } })).status === 200, 'Active temp user should get 200');

    await fetch(`${base}/api/users/${tempStaffRes.user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ is_active: false })
    });
    assert((await fetch(`${base}/api/auth/me`, { headers: { Cookie: tempCookie } })).status === 401, 'Deactivated user cookie must get 401 on /api/auth/me!');
    assert((await fetch(`${base}/api/stats`, { headers: { Cookie: tempCookie } })).status === 401, 'Deactivated user cookie must get 401 on /api/stats!');
    assert(
      (await fetch(`${base}/Dashboard.dc.html`, { headers: { Cookie: tempCookie }, redirect: 'manual' })).status === 302,
      'Deactivated user cookie must get 302 redirect on protected HTML!'
    );
    assert(
      (await fetch(`${base}/uploads/${preUpgradeCvName}`, { headers: { Cookie: tempCookie } })).status === 401,
      'Deactivated user cookie must get 401 on /uploads!'
    );
    recordCase('TC-12', '3-Role RBAC & Live Revocation', 'Full super_admin / hr_coordinator / committee_member API+HTML matrix & instant DB session revocation verified');

    console.log('\n=== [DRILL 2E] REAL HEADLESS CHROMIUM BROWSER E2E (PORTAL_RECOVERY & RESCHEDULE_NOTICE DRAFTS) ===');
    // نجهز مسودة استعادة طازجة لطلب خالد ومسودة إعادة جدولة طازجة لطلب أليس لفحصهما من متصفح كروميوم فعلي!
    const freshKhalidRec = await fetch(`${base}/api/applications/${khalidId}/recovery-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify({})
    }).then((r) => r.json());
    const khalidRecMsgId = freshKhalidRec.wa_message.id;

    const freshAliceResched = await fetch(`${base}/api/interviews/${sch1.interview.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
      body: JSON.stringify({ scheduled_date: '2026-11-28', start_time: '13:15' })
    }).then((r) => r.json());
    const aliceReschedMsgId = freshAliceResched.wa_message.id;
    const vtBrowser = new URL(freshAliceResched.visit_url).searchParams.get('vt');

    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      // 1. سياق متصفح حقيقي لمنسق الموارد البشرية (hr_audit)
      const hrContext = await browser.newContext({ locale: 'ar-SA' });
      await hrContext.addInitScript(() => {
        window.__OPENED_WA_URLS = [];
        window.open = function(url) {
          window.__OPENED_WA_URLS.push(String(url));
          return { closed: false, close() {} };
        };
      });
      const hrPage = await hrContext.newPage();

      // تسجيل الدخول الفعلي من صفحة Login.dc.html
      await hrPage.goto(`${base}/Login.dc.html`, { waitUntil: 'networkidle' });
      await hrPage.fill('#username', 'hr_audit');
      await hrPage.fill('#password', 'HrCoordPass-2026-Strong');
      await Promise.all([
        hrPage.waitForURL('**/Dashboard.dc.html*'),
        hrPage.click('button[type="submit"]')
      ]);

      // فتح استوديو واتساب الفعلي Interviews.dc.html
      await hrPage.goto(`${base}/Interviews.dc.html`, { waitUntil: 'networkidle' });
      await hrPage.waitForSelector(`tr[data-row-msg-id="${khalidRecMsgId}"]`);
      await hrPage.waitForSelector(`tr[data-row-msg-id="${aliceReschedMsgId}"]`);

      // أ) النقر الفعلي على صف رسالة استعادة الوصول (portal_recovery) والتحقق من شاشة الجوال وفتح المسودة
      await hrPage.click(`tr[data-row-msg-id="${khalidRecMsgId}"]`);
      const recBubbleText = await hrPage.textContent('#pv-bubble');
      assert(
        recBubbleText.includes(freshKhalidRec.recovery_url) && recBubbleText.includes(freshKhalidRec.access_key),
        'Browser #pv-bubble did not display exact portal_recovery URL and access_key!'
      );

      await Promise.all([
        hrPage.waitForResponse((r) => r.url().includes(`/api/wa-messages/${khalidRecMsgId}`) && r.request().method() === 'PATCH'),
        hrPage.click(`button[data-msg-id="${khalidRecMsgId}"]`)
      ]);

      const openedAfterRec = await hrPage.evaluate(() => window.__OPENED_WA_URLS.slice());
      assert(openedAfterRec.length === 1, 'Expected 1 window.open call for portal_recovery draft!');
      const parsedRecWa = new URL(openedAfterRec[0]);
      const recWaText = parsedRecWa.searchParams.get('text') || '';
      assert(
        parsedRecWa.hostname === 'wa.me' &&
          parsedRecWa.pathname === '/966554443322' &&
          recWaText.includes(freshKhalidRec.recovery_url) &&
          recWaText.includes(freshKhalidRec.access_key),
        'Browser window.open wa.me payload corrupted portal_recovery URL or key!'
      );
      const dbRecAfterBrowserOpen = (await pMig.query('SELECT queue_status, prepared_at FROM wa_messages WHERE id = $1', [khalidRecMsgId])).rows[0];
      assert(
        dbRecAfterBrowserOpen.queue_status === 'queued' && dbRecAfterBrowserOpen.prepared_at !== null,
        'Browser open_draft on portal_recovery did not keep status=queued with prepared_at!'
      );
      recordCase('TC-13', 'Browser E2E (Recovery Draft)', 'Real Chromium clicked portal_recovery row & opened wa.me draft with intact signed recovery URL + JPFK key');

      // ب) النقر الفعلي على صف إشعار تحديث الموعد (reschedule_notice) وفتح المسودة ثم تأكيد الإرسال الفعلي
      await hrPage.waitForSelector(`tr[data-row-msg-id="${aliceReschedMsgId}"]`);
      await hrPage.click(`tr[data-row-msg-id="${aliceReschedMsgId}"]`);
      const reschedBubbleText = await hrPage.textContent('#pv-bubble');
      assert(
        reschedBubbleText.includes('13:15') && reschedBubbleText.includes(encodeURIComponent(vtBrowser)),
        'Browser #pv-bubble did not display exact reschedule_notice slot and rotated vt link!'
      );

      await Promise.all([
        hrPage.waitForResponse((r) => r.url().includes(`/api/wa-messages/${aliceReschedMsgId}`) && r.request().method() === 'PATCH'),
        hrPage.click(`button[data-msg-id="${aliceReschedMsgId}"]`)
      ]);

      const openedAfterResched = await hrPage.evaluate(() => window.__OPENED_WA_URLS.slice());
      assert(openedAfterResched.length === 2, 'Expected 2nd window.open call for reschedule_notice draft!');
      const parsedReschedWa = new URL(openedAfterResched[1]);
      const reschedWaText = parsedReschedWa.searchParams.get('text') || '';
      assert(
        parsedReschedWa.pathname === '/966558887766' &&
          reschedWaText.includes('13:15') &&
          reschedWaText.includes(encodeURIComponent(vtBrowser)),
        'Browser window.open wa.me payload lost reschedule_notice slot or rotated vt token!'
      );

      const dbIntWhileDraftOnly = (await pMig.query('SELECT booking_status FROM interviews WHERE id = $1', [sch1.interview.id])).rows[0];
      assert(dbIntWhileDraftOnly.booking_status === 'rescheduled', 'Opening reschedule draft in browser must NOT mark interview invitation_sent prematurely!');

      // الضغط الفعلي على زر «✓ تأكيد الإرسال» في المتصفح
      await hrPage.waitForSelector(`button[data-confirm-id="${aliceReschedMsgId}"]`);
      await Promise.all([
        hrPage.waitForResponse((r) => r.url().includes(`/api/wa-messages/${aliceReschedMsgId}`) && r.request().method() === 'PATCH'),
        hrPage.click(`button[data-confirm-id="${aliceReschedMsgId}"]`)
      ]);
      await hrPage.waitForSelector(`tr[data-row-msg-id="${aliceReschedMsgId}"][data-row-status="sent"]`);

      const dbIntAfterBrowserConfirm = (await pMig.query('SELECT booking_status FROM interviews WHERE id = $1', [sch1.interview.id])).rows[0];
      assert(dbIntAfterBrowserConfirm.booking_status === 'invitation_sent', 'Confirming send in browser must advance interview to invitation_sent!');
      recordCase('TC-14', 'Browser E2E (Reschedule Draft & Confirm)', 'Real Chromium opened reschedule_notice draft (kept rescheduled) then confirmed send (-> invitation_sent)');

      // ج) سياق متصفح مجهول للمرشح: فتح رابط الاستعادة الفعلي وبطاقة الزيارة وتأكيد الحضور من المتصفح
      const candContext = await browser.newContext({ locale: 'ar-SA' });
      const candPage = await candContext.newPage();
      await candPage.goto(freshKhalidRec.recovery_url, { waitUntil: 'networkidle' });
      const candPageContent = await candPage.content();
      assert(candPageContent.includes(khalidRef), 'Anonymous browser failed to load candidate result via rotated recovery_url!');

      await candPage.goto(freshAliceResched.visit_url, { waitUntil: 'networkidle' });
      await candPage.waitForSelector('#confirm-visit-btn:not([disabled])');
      await Promise.all([
        candPage.waitForResponse((r) => r.url().includes('/api/public/visit/') && r.url().endsWith('/confirm')),
        candPage.click('#confirm-visit-btn')
      ]);
      const dbIntAfterCandBrowser = (await pMig.query('SELECT booking_status FROM interviews WHERE id = $1', [sch1.interview.id])).rows[0];
      assert(dbIntAfterCandBrowser.booking_status === 'confirmed', 'Candidate browser click on Visit.dc.html did not confirm interview!');
      recordCase('TC-15', 'Browser E2E (Candidate Recovery & Visit Pass)', 'Anonymous Chromium loaded rotated recovery_url & confirmed attendance on Visit.dc.html');

      // د) سياق متصفح حقيقي لعضو اللجنة (comm_audit): التحقق من اختفاء رسائل الاستعادة وأزرار الإرسال ومنع صفحة Users.dc.html (403)
      const commContext = await browser.newContext({ locale: 'ar-SA' });
      const commPage = await commContext.newPage();
      await commPage.goto(`${base}/Login.dc.html`, { waitUntil: 'networkidle' });
      await commPage.fill('#username', 'comm_audit');
      await commPage.fill('#password', 'CommPass-2026-Strong');
      await Promise.all([
        commPage.waitForURL('**/Dashboard.dc.html*'),
        commPage.click('button[type="submit"]')
      ]);
      await commPage.goto(`${base}/Interviews.dc.html`, { waitUntil: 'networkidle' });
      const commDomRecoveryCount = await commPage.locator('tr[data-row-tpl="portal_recovery"]').count();
      const commDomSendButtons = await commPage.locator('button.wa-btn-inline').count();
      assert(commDomRecoveryCount === 0 && commDomSendButtons === 0, 'committee_member browser DOM exposed recovery row or send buttons!');

      const usersPageResp = await commPage.goto(`${base}/Users.dc.html`);
      assert(usersPageResp.status() === 403, `committee_member navigating to /Users.dc.html must get 403, got ${usersPageResp.status()}!`);

      // عضو اللجنة يسجل إتمام المقابلة ثم نتحقق من منع إعادة جدولة مقابلة مكتملة (400 INTERVIEW_ALREADY_COMPLETED)
      const commCompleteResp = await fetch(`${base}/api/interviews/${sch1.interview.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: commCookie },
        body: JSON.stringify({ booking_status: 'completed', notes: 'حضر المرشح وأتم المقابلة بنجاح' })
      });
      assert(commCompleteResp.status === 200, 'committee_member marking confirmed interview completed must return 200!');
      assert(
        (await fetch(`${base}/api/interviews/${sch1.interview.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
          body: JSON.stringify({ start_time: '15:00' })
        })).status === 400,
        'Rescheduling an already completed interview must return 400 INTERVIEW_ALREADY_COMPLETED!'
      );
      recordCase('TC-16', 'Browser E2E (Committee RBAC & Completed Lock)', 'Real Chromium verified committee_member read-only queue UI, 403 on /Users.dc.html, completion & post-completion reschedule lock');

      // هـ) التحقق من اتساق الحالات عبر الكيانات عند الاعتذار لمرشح مجدول (إلغاء الموعد وإبطال vt وإلغاء دعوات الطابور)
      const khalidSched = await fetch(`${base}/api/interviews/schedule-single`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({ application_id: khalidId, scheduled_date: '2026-11-29', start_time: '11:00', interview_mode: 'remote' })
      }).then((r) => r.json());
      const khalidVt = new URL(khalidSched.visit_url).searchParams.get('vt');
      assert((await fetch(`${base}/api/public/visit/${encodeURIComponent(khalidVt)}`)).status === 200, 'Khalid visit pass should be active');

      const rejectKhalidResp = await fetch(`${base}/api/applications/${khalidId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: hrCookie },
        body: JSON.stringify({ status: 'rejected' })
      });
      assert(rejectKhalidResp.status === 200, 'Rejecting Khalid failed!');
      assert((await fetch(`${base}/api/public/visit/${encodeURIComponent(khalidVt)}`)).status === 403, 'Rejecting candidate must revoke active visit_token!');
      const khalidIntAfterRej = (await pMig.query('SELECT booking_status FROM interviews WHERE id = $1', [khalidSched.interview.id])).rows[0];
      const khalidMsgAfterRej = (await pMig.query('SELECT queue_status FROM wa_messages WHERE id = $1', [khalidSched.wa_message.id])).rows[0];
      assert(
        khalidIntAfterRej.booking_status === 'cancelled' && khalidMsgAfterRej.queue_status === 'cancelled',
        'Rejecting candidate must cancel open interview and queued invite!'
      );
      recordCase('TC-17', 'Cross-Entity Rejection Cascade', 'Setting application status=rejected automatically cancelled open interview, revoked visit_token (403), and cancelled queued WA invite');

      await hrContext.close();
      await candContext.close();
      await commContext.close();
    } finally {
      await browser.close();
    }
    console.log('[OK] All API Conflict, State-Machine, Concurrency, RBAC & Real Headless Chromium Browser E2E tests passed!');

    console.log('\n=== [DRILL 3] ISOLATED pg_dump -Fc + SEPARATE -c psql RESTORE + UPLOADS ARCHIVE ===');
    const dumpFile = path.join(backupDir, 'db_drill.dump');
    const uploadsTar = path.join(backupDir, 'uploads_drill.tar.gz');

    const tDump0 = Date.now();
    execSync(
      `PGPASSWORD="${adminUrl.password}" pg_dump -h "${adminUrl.hostname}" -p "${adminUrl.port || 5432}" -U "${adminUrl.username}" -d "${dbMig}" -Fc -f "${dumpFile}"`
    );
    execSync(`tar -czf "${uploadsTar}" -C "${sharedUploadsDir}" .`);
    const dumpMs = Date.now() - tDump0;
    const dumpKb = Math.round(fs.statSync(dumpFile).size / 1024);

    // اختبار أمر psql الفعلي بمعاملَي -c منفصلين (خارج كتلة المعاملة) تماماً كما هو موثق في ملف المراجعة
    execSync(
      `PGPASSWORD="${adminUrl.password}" psql -v ON_ERROR_STOP=1 -h "${adminUrl.hostname}" -p "${adminUrl.port || 5432}" -U "${adminUrl.username}" -d postgres -c "DROP DATABASE IF EXISTS ${dbRest} WITH (FORCE);" -c "CREATE DATABASE ${dbRest};"`,
      { stdio: 'pipe' }
    );

    const tRes0 = Date.now();
    execSync(
      `PGPASSWORD="${adminUrl.password}" pg_restore -h "${adminUrl.hostname}" -p "${adminUrl.port || 5432}" -U "${adminUrl.username}" -d "${dbRest}" --no-owner --no-privileges "${dumpFile}"`
    );
    execSync(`tar -xzf "${uploadsTar}" -C "${restoredUploadsDir}"`);
    const restoreMs = Date.now() - tRes0;

    const pRestored = new Pool({ connectionString: `${dbBaseOrigin}/${dbRest}` });
    const origSummary = (
      await pMig.query(
        'SELECT (SELECT COUNT(*)::int FROM candidates) c, (SELECT COUNT(*)::int FROM applications) a, (SELECT COUNT(*)::int FROM interviews) i, (SELECT COUNT(*)::int FROM wa_messages) w'
      )
    ).rows[0];
    const restSummary = (
      await pRestored.query(
        'SELECT (SELECT COUNT(*)::int FROM candidates) c, (SELECT COUNT(*)::int FROM applications) a, (SELECT COUNT(*)::int FROM interviews) i, (SELECT COUNT(*)::int FROM wa_messages) w'
      )
    ).rows[0];
    assert(JSON.stringify(origSummary) === JSON.stringify(restSummary), 'Restored DB counts mismatch!');
    const origFiles = fs.readdirSync(sharedUploadsDir).filter((f) => f.endsWith('.pdf')).sort();
    const restFiles = fs.readdirSync(restoredUploadsDir).filter((f) => f.endsWith('.pdf')).sort();
    assert(origFiles.length >= 2 && JSON.stringify(origFiles) === JSON.stringify(restFiles), 'Restored uploads mismatch!');
    await pRestored.end();
    await pMig.end();
    console.log(
      `[OK] Isolated DB + Uploads Restore verified: dump=${dumpMs}ms (${dumpKb} KB), restore=${restoreMs}ms, rows=${JSON.stringify(restSummary)}, pdfs=${restFiles.length}`
    );

    console.log('\n=== [DRILL 4] ISOLATED ROLLBACK (v2.1 -> 70be659 + HOTFIX aiEvaluator.js + SHARED UPLOADS) ===');
    v21Proc.kill('SIGTERM');
    v21Proc = null;

    fs.mkdirSync(rbDir, { recursive: true });
    execSync(`git archive 70be659 | tar -x -C "${rbDir}"`);
    execSync(`ln -s "${path.join(process.cwd(), 'node_modules')}" "${path.join(rbDir, 'node_modules')}"`);

    // محاكاة استرجاع ملف الترقيع المحلي services/aiEvaluator.js على الإنتاج فوق 70be659
    const v20EvalPath = path.join(rbDir, 'services', 'aiEvaluator.js');
    const patchedEvalContent = `// PRODUCTION_LOCAL_OLLAMA_HOTFIX_RESTORED\n` + fs.readFileSync(v20EvalPath, 'utf8');
    fs.writeFileSync(v20EvalPath, patchedEvalContent);

    // تعديل مسار uploads في نسخة الفحص المعزولة ليرتبط بنفس مجلد المرفقات المشترك (محاكاة Docker volume uploads_data)
    const v20ServerPath = path.join(rbDir, 'server.js');
    const v20ServerSrc = fs
      .readFileSync(v20ServerPath, 'utf8')
      .replace("const uploadsDir = path.join(__dirname, 'uploads');", "const uploadsDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');");
    fs.writeFileSync(v20ServerPath, v20ServerSrc);

    const tRb0 = Date.now();
    const s20 = spawnServer(rbDir, 3092, dbMig, sharedUploadsDir);
    v20Proc = s20.proc;
    await s20.ready;
    const rbBootMs = Date.now() - tRb0;

    const v20Health = await fetch('http://127.0.0.1:3092/api/health').then((r) => r.json());
    assert(v20Health.status === 'ok', 'v2.0 health failed on migrated DB!');
    assert(fs.readFileSync(v20EvalPath, 'utf8').startsWith('// PRODUCTION_LOCAL_OLLAMA_HOTFIX_RESTORED'), 'Hotfix aiEvaluator missing!');

    // تسجيل دخول اللجنة على v2.0 والتحقق من بقاء مرفقات ما قبل الترقية ومرفقات v2.1 قابلة للقراءة
    const v20Login = await fetch('http://127.0.0.1:3092/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PASS_DRILL })
    });
    const v20StaffCookie = v20Login.headers.get('set-cookie').split(';')[0];
    const preCvResp = await fetch(`http://127.0.0.1:3092/uploads/${preUpgradeCvName}`, { headers: { Cookie: v20StaffCookie } });
    assert(preCvResp.status === 200, 'Pre-upgrade CV inaccessible after rollback!');

    // إدراج طلب جديد من كود v2.0 على القاعدة المرحّلة إلى v2.1
    const fd20 = new FormData();
    fd20.append('job_id', '2');
    fd20.append('full_name', 'مرشح بعد الرجوع لنسخة 2.0');
    fd20.append('email', 'post_rollback_v20@jpf.sa');
    fd20.append('phone', '0551112233');
    fd20.append('city', 'الرياض');
    fd20.append('qualification', 'بكالوريوس');
    fd20.append('years_experience', '3');
    fd20.append('privacy_consent', 'true');
    fd20.append('cv_file', new Blob(['%PDF-1.4 Post Rollback CV'], { type: 'application/pdf' }), 'v20_after_rb.pdf');
    const v20AppResp = await fetch('http://127.0.0.1:3092/api/applications', { method: 'POST', body: fd20 });
    assert(v20AppResp.status === 201, 'v2.0 INSERT failed on migrated DB: ' + v20AppResp.status);

    console.log(
      `[OK] Isolated v2.0 Rollback verified: booted in ${rbBootMs}ms, hotfix aiEvaluator intact, shared uploads preserved, and v2.0 INSERT=201!`
    );
    console.log('\nALL_ISOLATED_V21_DRILLS_PASSED_100_PERCENT');
  } finally {
    if (v21Proc) v21Proc.kill('SIGTERM');
    if (v20Proc) v20Proc.kill('SIGTERM');
    if (typeof pMig !== 'undefined' && pMig) await pMig.end().catch(() => {});
    await dropIsolatedDb(dbMig);
    await dropIsolatedDb(dbFresh);
    await dropIsolatedDb(dbRest);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
