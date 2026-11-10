require('dotenv').config();
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const { Pool } = require('pg');
const { createSessionToken, COOKIE_NAME } = require('../services/auth');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
}

const adminDbUrl = new URL(process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/smart_hr_db');
const dbBaseOrigin = `${adminDbUrl.protocol}//${adminDbUrl.username}:${adminDbUrl.password}@${adminDbUrl.host}`;

function recreateDb(dbName) {
  execSync(`sudo -u postgres psql -c "DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);"`, { stdio: 'pipe' });
  execSync(`sudo -u postgres psql -c "CREATE DATABASE ${dbName} OWNER ${adminDbUrl.username};"`, { stdio: 'pipe' });
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

(async () => {
  console.log('=== [DRILL 1] POPULATED v2.0 (70be659) -> v2.1 UPGRADE & SCHEMA PARITY ===');
  recreateDb('drill_v20_populated');
  recreateDb('drill_v21_fresh');

  // 1A. تهيئة قاعدة مأهولة مطابقة لإصدار الإنتاج v2.0 (70be659)
  const v20Sql = execSync('git show 70be659:database/schema_and_seed.sql', { encoding: 'utf8' });
  const pMig = new Pool({ connectionString: `${dbBaseOrigin}/drill_v20_populated` });
  await pMig.query(v20Sql);

  // تعديل قالب موجود + إضافة مفتاح مخصص إضافي للتأكد من عدم فقدانهما عند الترقية
  await pMig.query(
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
    await pMig.query(`
      SELECT (SELECT COUNT(*)::int FROM jobs) AS jobs,
             (SELECT COUNT(*)::int FROM candidates) AS cands,
             (SELECT COUNT(*)::int FROM applications) AS apps,
             (SELECT COUNT(*)::int FROM interviews) AS ints
    `)
  ).rows[0];
  console.log('Pre-upgrade v2.0 counts:', preCounts);
  await pMig.end();

  // 1B. تشغيل ترحيل v2.1 على القاعدة المأهولة وقياس الزمن الفعلي
  const tMig0 = Date.now();
  execSync(
    `DATABASE_URL="${dbBaseOrigin}/drill_v20_populated" node -e "const {ensureDatabaseInitialized, pool}=require('./database/db'); ensureDatabaseInitialized().then(()=>pool.end())"`,
    { stdio: 'pipe' }
  );
  const migMs = Date.now() - tMig0;

  // 1C. تهيئة قاعدة نظيفة من schema_and_seed.sql في v2.1 للمقارنة الصارمة للأعمدة
  execSync(
    `DATABASE_URL="${dbBaseOrigin}/drill_v21_fresh" node -e "const {ensureDatabaseInitialized, pool}=require('./database/db'); ensureDatabaseInitialized().then(()=>pool.end())"`,
    { stdio: 'pipe' }
  );

  const pMigAfter = new Pool({ connectionString: `${dbBaseOrigin}/drill_v20_populated` });
  const pFresh = new Pool({ connectionString: `${dbBaseOrigin}/drill_v21_fresh` });

  const postCounts = (
    await pMigAfter.query(`
      SELECT (SELECT COUNT(*)::int FROM jobs) AS jobs,
             (SELECT COUNT(*)::int FROM candidates) AS cands,
             (SELECT COUNT(*)::int FROM applications) AS apps,
             (SELECT COUNT(*)::int FROM interviews) AS ints
    `)
  ).rows[0];
  assert(JSON.stringify(preCounts) === JSON.stringify(postCounts), 'Row counts changed after migration!');

  // التحقق من النقطة (1): الحفاظ الكامل على مفاتيح وقيم whatsapp_templates السابقة
  const tplRow = (
    await pMigAfter.query("SELECT setting_value FROM system_settings WHERE setting_key = 'whatsapp_templates'")
  ).rows[0].setting_value;
  assert(tplRow.interview_invite === 'نص دعوة مخصص سابق من الموارد البشرية', 'Custom interview_invite value was overwritten!');
  assert(tplRow.custom_hr_special === 'قالب خاص إضافي محفوظ في الإنتاج', 'Custom key custom_hr_special was lost!');
  assert(Boolean(tplRow.pass_notification) && Boolean(tplRow.reschedule_notice), 'Original seed keys were lost!');
  assert(
    Boolean(tplRow.interview_inperson) && Boolean(tplRow.confirm_booking) && Boolean(tplRow.send_room_now),
    'New v2.1 template keys were not merged!'
  );
  console.log(
    `[OK] Migration duration: ${migMs}ms | Preserved all ${Object.keys(tplRow).length} whatsapp_templates keys including custom HR values!`
  );

  // التحقق من النقطة (4): تطابق 100% في تعريفات الأعمدة والـ DEFAULT والـ NOT NULL بين الترحيل والتأسيس
  const sigMig = await getColumnsSignature(pMigAfter);
  const sigFresh = await getColumnsSignature(pFresh);
  const diffMigOnly = sigMig.filter((x) => !sigFresh.includes(x));
  const diffFreshOnly = sigFresh.filter((x) => !sigMig.includes(x));
  assert(
    diffMigOnly.length === 0 && diffFreshOnly.length === 0,
    'Column parity mismatch: ' + JSON.stringify({ diffMigOnly, diffFreshOnly })
  );
  console.log(`[OK] 100% Column Schema Parity verified across ${sigFresh.length} columns (0 differences)!`);
  await pFresh.end();

  console.log('\n=== [DRILL 2] PURPOSE-SCOPED TOKENS (POINT 2) & WA STATUS INTEGRITY (POINT 3) ===');
  const base = 'http://127.0.0.1:3000';
  const mainPool = new Pool({ connectionString: process.env.DATABASE_URL });
  await mainPool.query('DELETE FROM candidates WHERE email = $1', ['sec_drill@jpf.sa']);

  // فحص إغلاق المسار العام الموروث ومنع التعداد التسلسلي
  assert((await fetch(base + '/api/applications/1')).status === 401, 'Numeric ID must return 401');
  const unauthRefResp = await fetch(base + '/api/applications/APP-2026-1001');
  assert(unauthRefResp.status === 403, 'Sequential ref without token must return 403');
  const unauthJson = await unauthRefResp.json();
  assert(!unauthJson.application && !unauthJson.ai_report, 'Unauth response leaked application data!');
  assert((await fetch(base + '/api/assessments/status/APP-2026-1001')).status === 403, 'Status poll without token must return 403');
  assert((await fetch(base + '/api/public/visit/APP-2026-1001')).status === 403, 'Visit pass must reject sequential ref');
  assert(
    (await fetch(base + '/api/public/visit/APP-2026-1001/confirm', { method: 'POST' })).status === 403,
    'Visit confirm must reject sequential ref'
  );

  // تقديم طلب شرعي واستلام كوكي المتقدم المقيّد بالغرض
  const fd = new FormData();
  fd.append('job_id', '1');
  fd.append('full_name', 'مرشح فحص الأمان');
  fd.append('email', 'sec_drill@jpf.sa');
  fd.append('phone', '0558887766');
  fd.append('city', 'جدة');
  fd.append('qualification', 'ماجستير');
  fd.append('specialization', 'هندسة كيميائية');
  fd.append('years_experience', '6');
  fd.append('privacy_consent', 'true');
  fd.append('cv_file', new Blob(['%PDF-1.4 Security Test CV ISO 9001'], { type: 'application/pdf' }), 'sec_cv.pdf');

  const applyResp = await fetch(base + '/api/applications', { method: 'POST', body: fd });
  assert(applyResp.status === 201, 'Apply failed: ' + applyResp.status);
  const candCookie = applyResp.headers.get('set-cookie').split(';')[0];
  const applyData = await applyResp.json();
  const refNo = applyData.reference_no;

  // رفض استخدام رمز candidate_portal على مسار visit_pass (تقييد الغرض)
  assert(
    (await fetch(base + '/api/public/visit/' + encodeURIComponent(applyData.candidate_token))).status === 403,
    'candidate_portal token must be rejected on visit_pass endpoint!'
  );

  // إرسال الاختبار وقياس الزمن الفعلي
  const jobQs = (await mainPool.query('SELECT questions FROM jobs WHERE id = 1')).rows[0].questions;
  const ans = jobQs.map((q) => ({
    question_index: q.index,
    answer_value:
      q.type === 'mcq'
        ? String(q.correct_option)
        : q.type === 'numeric'
          ? String(q.correct_number)
          : 'تطبيق معايير السلامة والجودة ISO 9001 ومراقبة اللزوجة والكثافة بدقة.',
    time_taken_seconds: 10
  }));
  const tSub0 = Date.now();
  const subResp = await fetch(base + '/api/assessments/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: candCookie },
    body: JSON.stringify({ reference_no: refNo, answers: ans, telemetry: { tab_switches: 0, paste_attempts: 0, time_spent_seconds: 95 } })
  });
  const subMs = Date.now() - tSub0;
  assert(subResp.status === 200, 'Assessment submit failed');

  // التأكد من عدم تسريب حقول تقرير اللجنة الداخلية للمتقدم حتى بعد توثيقه
  const ownApp = await fetch(base + '/api/applications/' + refNo, { headers: { Cookie: candCookie } }).then((r) => r.json());
  assert(
    ownApp.application.email === undefined && ownApp.application.cv_stored_path === undefined,
    'PII/CV path leaked to public candidate endpoint!'
  );
  assert(
    ownApp.application.committee_avg_score === undefined &&
      ownApp.application.ai_report.blind_summary === undefined &&
      ownApp.application.ai_report.risks === undefined,
    'Internal committee report leaked!'
  );
  console.log(`[OK] Security scoping & report sanitization verified | Submit latency = ${subMs}ms!`);

  // التحقق من النقطة (3): فتح مسودة wa.me لا يسجّل الرسالة كمرسلة (sent)
  const adminRow = (await mainPool.query("SELECT * FROM staff_users WHERE role = 'super_admin' LIMIT 1")).rows[0];
  const staffCookie = COOKIE_NAME + '=' + createSessionToken(adminRow);
  const appId = (await mainPool.query('SELECT id FROM applications WHERE reference_no = $1', [refNo])).rows[0].id;

  const schResp = await fetch(base + '/api/interviews/schedule-single', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
    body: JSON.stringify({
      application_id: appId,
      scheduled_date: '2026-11-20',
      start_time: '10:00',
      interview_mode: 'in_person',
      open_draft: true
    })
  }).then((r) => r.json());

  assert(schResp.wa_message.queue_status === 'queued', 'Draft open must stay queued!');
  assert(schResp.wa_message.sent_at === null, 'sent_at must remain null on draft open!');
  assert(schResp.wa_message.prepared_at !== null, 'prepared_at must record draft open timestamp!');
  assert(schResp.interview.booking_status === 'scheduled', 'booking_status must remain scheduled until confirmed sent!');
  assert(schResp.visit_url.includes('Visit.dc.html?vt='), 'visit_url must use scoped vt token!');

  // التحقق من تأكيد الإرسال الفعلي الصريح
  const confirmSendResp = await fetch(base + '/api/wa-messages/' + schResp.wa_message.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
    body: JSON.stringify({ action: 'confirm_sent' })
  }).then((r) => r.json());
  assert(confirmSendResp.message.queue_status === 'sent' && confirmSendResp.message.sent_at !== null, 'Explicit confirm_sent failed!');
  const intAfterSend = (await mainPool.query('SELECT booking_status FROM interviews WHERE id = $1', [schResp.interview.id])).rows[0];
  assert(intAfterSend.booking_status === 'invitation_sent', 'Interview booking_status must become invitation_sent after confirm_sent!');

  // التحقق من بطاقة الزيارة وتأكيد الحضور بالرمز المقيّد بالغرض vt
  const vtParam = new URL(schResp.visit_url).searchParams.get('vt');
  assert(
    (await fetch(base + '/api/applications/' + refNo + '?ct=' + encodeURIComponent(vtParam))).status === 403,
    'visit_pass token must fail on candidate_portal endpoint!'
  );
  assert((await fetch(base + '/api/public/visit/' + encodeURIComponent(vtParam))).status === 200, 'Valid vt failed on GET visit');
  const visitConf = await fetch(base + '/api/public/visit/' + encodeURIComponent(vtParam) + '/confirm', { method: 'POST' }).then((r) =>
    r.json()
  );
  assert(visitConf.booking_status === 'confirmed', 'Candidate attendance confirm failed!');
  console.log('[OK] WhatsApp draft vs confirmed-sent lifecycle & Visit Pass vt token verified!');

  await mainPool.query('DELETE FROM candidates WHERE email = $1', ['sec_drill@jpf.sa']);
  await mainPool.end();

  console.log('\n=== [DRILL 3] ISOLATED pg_dump -Fc BACKUP & pg_restore VERIFICATION ===');
  await pMigAfter.query(
    `INSERT INTO candidates (full_name, email, phone, city, years_experience, qualification, specialization, cv_filename, cv_stored_path)
     VALUES ($1, $2, $3, 'جدة', 4, 'بكالوريوس', 'هندسة صناعية', 'rb.pdf', '/uploads/samples/sample-cv-1.pdf')`,
    ['مرشح تجربة الرجوع', 'rollback_cand@jpf.sa', '0554443322']
  );
  await pMigAfter.query(
    `INSERT INTO applications (reference_no, job_id, candidate_id, status, assessment_score, ai_overall_score, privacy_consent)
     VALUES ('APP-2026-1099', 1, (SELECT id FROM candidates WHERE email = $1), 'interview_scheduled', 84, 80, TRUE)`,
    ['rollback_cand@jpf.sa']
  );
  await pMigAfter.query(
    `INSERT INTO interviews (application_id, scheduled_date, start_time, end_time, duration_minutes, meeting_platform, meeting_url, interview_mode, location_floor, location_office)
     VALUES ((SELECT id FROM applications WHERE reference_no = 'APP-2026-1099'), '2026-11-22', '11:00', '11:30', 30, 'مقابلة حضورية', 'https://hrjpf.tech', 'in_person', 'الدور الثالث', 'مكتب 304')`
  );

  const dumpFile = '/tmp/smarthr_drill_backup.dump';
  const tDump0 = Date.now();
  execSync(`PGPASSWORD="${adminDbUrl.password}" pg_dump -h 127.0.0.1 -U "${adminDbUrl.username}" -d drill_v20_populated -Fc -f ${dumpFile}`);
  const dumpMs = Date.now() - tDump0;
  const dumpKb = Math.round(fs.statSync(dumpFile).size / 1024);

  recreateDb('drill_restore_isolated');
  const tRes0 = Date.now();
  execSync(
    `PGPASSWORD="${adminDbUrl.password}" pg_restore -h 127.0.0.1 -U "${adminDbUrl.username}" -d drill_restore_isolated --no-owner --no-privileges ${dumpFile}`
  );
  const restoreMs = Date.now() - tRes0;

  const pRestored = new Pool({ connectionString: `${dbBaseOrigin}/drill_restore_isolated` });
  const origSummary = (
    await pMigAfter.query(
      'SELECT (SELECT COUNT(*)::int FROM candidates) c, (SELECT COUNT(*)::int FROM applications) a, (SELECT COUNT(*)::int FROM interviews) i'
    )
  ).rows[0];
  const restSummary = (
    await pRestored.query(
      'SELECT (SELECT COUNT(*)::int FROM candidates) c, (SELECT COUNT(*)::int FROM applications) a, (SELECT COUNT(*)::int FROM interviews) i'
    )
  ).rows[0];
  assert(JSON.stringify(origSummary) === JSON.stringify(restSummary), 'Restore row count mismatch!');
  console.log(
    `[OK] Isolated Backup & Restore Verified: pg_dump=${dumpMs}ms (${dumpKb} KB), pg_restore=${restoreMs}ms, rows=${JSON.stringify(restSummary)}`
  );
  await pRestored.end();
  await pMigAfter.end();

  console.log('\n=== [DRILL 4] ACTUAL ROLLBACK EXECUTION (v2.1 -> 70be659 v2.0 ON MIGRATED DB) ===');
  const rbDir = '/tmp/jpf_v20_rollback_test';
  execSync(`rm -rf ${rbDir} && mkdir -p ${rbDir} && git archive 70be659 | tar -x -C ${rbDir}`);
  execSync(`ln -s /home/user/node_modules ${rbDir}/node_modules && cp -r /home/user/uploads ${rbDir}/uploads`);

  const tRb0 = Date.now();
  const rbProc = spawn('node', ['server.js'], {
    cwd: rbDir,
    env: {
      ...process.env,
      PORT: '3099',
      HOST: '127.0.0.1',
      DATABASE_URL: `${dbBaseOrigin}/drill_v20_populated`,
      ADMIN_ACCESS_CODE: 'RB-ADMIN-2026'
    },
    stdio: 'pipe'
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('v2.0 rollback server start timeout')), 8000);
    rbProc.stdout.on('data', (d) => {
      if (String(d).includes('3099')) {
        clearTimeout(timer);
        resolve();
      }
    });
    rbProc.stderr.on('data', (d) => console.error('[v2.0 stderr]:', String(d)));
  });
  const rbBootMs = Date.now() - tRb0;

  const v20Health = await fetch('http://127.0.0.1:3099/api/health').then((r) => r.json());
  assert(v20Health.status === 'ok', 'v2.0 health failed on migrated DB!');

  // التأكد من قدرة كود v2.0 بعد الرجوع على قراءة الطلبات المحدثة وإدراج طلب جديد في القاعدة المرحّلة دون خطأ
  const fd20 = new FormData();
  fd20.append('job_id', '2');
  fd20.append('full_name', 'مرشح بعد الرجوع لنسخة 2.0');
  fd20.append('email', 'post_rollback_v20@jpf.sa');
  fd20.append('phone', '0551112233');
  fd20.append('city', 'الرياض');
  fd20.append('qualification', 'بكالوريوس');
  fd20.append('years_experience', '3');
  fd20.append('privacy_consent', 'true');
  fd20.append('cv_file', new Blob(['%PDF-1.4 Post Rollback CV'], { type: 'application/pdf' }), 'v20.pdf');
  const v20AppResp = await fetch('http://127.0.0.1:3099/api/applications', { method: 'POST', body: fd20 });
  assert(v20AppResp.status === 201, 'v2.0 failed to INSERT into v2.1-migrated DB! Status: ' + v20AppResp.status);

  rbProc.kill('SIGTERM');
  execSync(`rm -rf ${rbDir} ${dumpFile}`);
  execSync('sudo -u postgres psql -c "DROP DATABASE IF EXISTS drill_v20_populated WITH (FORCE);"');
  execSync('sudo -u postgres psql -c "DROP DATABASE IF EXISTS drill_v21_fresh WITH (FORCE);"');
  execSync('sudo -u postgres psql -c "DROP DATABASE IF EXISTS drill_restore_isolated WITH (FORCE);"');
  console.log(
    `[OK] Actual v2.0 Rollback Drill Verified: v2.0 booted on migrated DB in ${rbBootMs}ms, /api/health=ok, and v2.0 INSERT succeeded cleanly!`
  );
  console.log('\nALL_4_HERMES_AUDIT_DRILLS_PASSED_100_PERCENT');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
