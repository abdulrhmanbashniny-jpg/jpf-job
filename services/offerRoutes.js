/**
 * مسارات v2.5: مصفوفة المقارنة + العروض الوظيفية + التوقيع الإلكتروني + n8n
 * ---------------------------------------------------------------------------------
 *  GET  /api/compare?job_id=X&ids=1,2,3      : مقارنة 2–4 مرشحين (جميع الموظفين)
 *  GET  /api/offers/template                 : قراءة القالب (جميع الموظفين)
 *  PUT  /api/offers/template                 : تعديل القالب (super_admin, hr_coordinator)
 *  POST /api/offers                          : إصدار عرض + PDF + بصمة + حدث n8n (super_admin, hr_coordinator)
 *  GET  /api/offers                          : قائمة العروض (جميع الموظفين)
 *  GET  /api/offers/:id/pdf                  : تنزيل PDF مخزَّن (super_admin, hr_coordinator)
 *  GET  /api/public/offers/:ot               : عرض المرشح (عام بتوكن offer_pass)
 *  POST /api/public/offers/:ot/respond       : قبول/اعتذار + توقيع (عام بتوكن offer_pass)
 *
 * ضوابط:
 *  - committee_member يستطيع المقارنة والقراءة فقط، ولا يُصدر عروضاً مالية إطلاقاً.
 *  - توكن العرض 256-بت عشوائي، يُخزَّن مُهشّراً للتحقق ولا يُعاد كاملاً في أي استجابة إدارية.
 *  - لا يُرسل أي بريد/واتساب تلقائي: الرابط يُعرض للمنسق ليتصرف يدوياً (Dry-Run قائم).
 *  - أي فشل n8n لا يُفشل الإصدار أو التوقيع.
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const OFFER_ISSUE_ROLES = Object.freeze(['super_admin', 'hr_coordinator']);
const MAX_COMPARE = 4;
const MIN_COMPARE = 2;

/** توكن عرض 256-بت (64 hex) */
function generateOfferToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function isValidTokenShape(token) {
  return /^[a-f0-9]{64}$/.test(String(token || ''));
}

/** رقم عرض تسلسلي مقروء: OFR-<سنة>-<تسلسل 4 خانات> */
function buildOfferRef(sequence, year = new Date().getFullYear()) {
  return `OFR-${year}-${String(sequence).padStart(4, '0')}`;
}

function safeInt(v, fallback = null) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function createOfferRoutes({
  query, pool, logAudit, requireAuth, offerPdf, outbox, uploadsDir
}) {
  const router = express.Router();
  const offersDir = path.join(uploadsDir || path.join(__dirname, '..', 'uploads'), 'offers');

  function ensureOffersDir() {
    if (!fs.existsSync(offersDir)) fs.mkdirSync(offersDir, { recursive: true });
    return offersDir;
  }

  // ---------------------------------------------------------------------------
  // 0) تسجيل حدث الأتمتة داخل معاملة قائمة — بلا أي قدرة على إفسادها.
  //
  //    الفخ الذي نتحمّى منه: في PostgreSQL، أي عبارة تفشل داخل معاملة تُجهض
  //    المعاملة كلها، فيتحول COMMIT إلى ROLLBACK **بصمت** ويفقد المستخدم
  //    عملية التوظيف بينما الاستجابة تعلن النجاح. لذلك نعزل الإدخال داخل
  //    SAVEPOINT: فشله يتراجع إلى نقطة الحفظ وحدها، وتبقى معاملة التوظيف سليمة.
  // ---------------------------------------------------------------------------
  async function safeEnqueueEvent(client, event) {
    try {
      await client.query('SAVEPOINT sp_outbox');
    } catch (_e) {
      // خارج معاملة (autocommit) — الإدخال آمن مباشرة
      return outbox.enqueueEvent((sql, params) => client.query(sql, params), event);
    }
    try {
      const result = await outbox.enqueueEvent((sql, params) => client.query(sql, params), event);
      await client.query('RELEASE SAVEPOINT sp_outbox');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK TO SAVEPOINT sp_outbox'); } catch (_e) { /* المعاملة منهارة */ }
      try { await client.query('RELEASE SAVEPOINT sp_outbox'); } catch (_e) { /* تجاهل */ }
      return { enqueued: false, error: 'ENQUEUE_FAILED', detail: String(err && err.message).slice(0, 200) };
    }
  }

  // ---------------------------------------------------------------------------
  // 1) مصفوفة المقارنة
  // ---------------------------------------------------------------------------
  router.get('/compare', requireAuth(), async (req, res) => {
    try {
      const rawIds = String(req.query.ids || '')
        .split(',')
        .map((s) => safeInt(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);

      const unique = [...new Set(rawIds)];
      if (unique.length < MIN_COMPARE || unique.length > MAX_COMPARE) {
        return res.status(400).json({
          error: `المقارنة تتطلب من ${MIN_COMPARE} إلى ${MAX_COMPARE} مرشحين.`,
          code: 'INVALID_COMPARE_SIZE',
          min: MIN_COMPARE,
          max: MAX_COMPARE
        });
      }

      const { rows } = await query(
        `SELECT a.id, a.reference_no, a.status,
                a.cv_match_score, a.assessment_score, a.ai_overall_score,
                a.committee_avg_score, a.final_weighted_score,
                a.voice_bonus_score, a.voice_pitch_path, a.voice_retention_expires_at,
                c.full_name, c.city, c.years_experience, c.qualification, c.specialization,
                LEFT(COALESCE(c.cv_extracted_text, ''), 600) AS cv_excerpt,
                c.national_id AS national_id_on_file,
                j.code AS job_code, j.title AS job_title, j.id AS job_id,
                i.scheduled_date, i.start_time, i.booking_status, i.interview_mode,
                i.punctuality_minutes, i.checked_in_at, i.actual_call_minutes
         FROM applications a
         JOIN candidates c ON c.id = a.candidate_id
         JOIN jobs j ON j.id = a.job_id
         LEFT JOIN interviews i ON i.application_id = a.id
         WHERE a.id = ANY($1::int[])`,
        [unique]
      );

      if (rows.length !== unique.length) {
        return res.status(404).json({
          error: 'بعض المرشحين المطلوبين غير موجودين.',
          code: 'COMPARE_SUBJECT_NOT_FOUND',
          found: rows.length,
          requested: unique.length
        });
      }

      // كل الطلبات يجب أن تكون على نفس الوظيفة — وإلا فالمقارنة مضللة
      const jobIds = [...new Set(rows.map((r) => r.job_id))];
      if (jobIds.length > 1) {
        return res.status(400).json({
          error: 'لا يمكن مقارنة مرشحين على وظائف مختلفة.',
          code: 'COMPARE_JOB_MISMATCH'
        });
      }

      const evalRes = await query(
        `SELECT application_id, evaluator_name, evaluator_role,
                technical_competence, communication_persuasion, problem_solving,
                cultural_fit, portfolio_practical, total_percentage, recommendation, notes
         FROM committee_evaluations
         WHERE application_id = ANY($1::int[])
         ORDER BY application_id, evaluated_at DESC`,
        [unique]
      );

      const evalsByApp = new Map();
      for (const e of evalRes.rows) {
        if (!evalsByApp.has(e.application_id)) evalsByApp.set(e.application_id, []);
        evalsByApp.get(e.application_id).push({
          evaluator_name: e.evaluator_name,
          evaluator_role: e.evaluator_role,
          technical_competence: Number(e.technical_competence),
          communication_persuasion: Number(e.communication_persuasion),
          problem_solving: Number(e.problem_solving),
          cultural_fit: Number(e.cultural_fit),
          portfolio_practical: Number(e.portfolio_practical),
          total_percentage: Number(e.total_percentage),
          recommendation: e.recommendation,
          notes: e.notes
        });
      }

      const candidates = rows.map((r) => {
        const evals = evalsByApp.get(r.id) || [];
        const avg = (key) => (evals.length
          ? Number((evals.reduce((s, e) => s + Number(e[key] || 0), 0) / evals.length).toFixed(2))
          : null);
        const voiceAvailable = Boolean(r.voice_pitch_path) &&
          !(r.voice_retention_expires_at && new Date(r.voice_retention_expires_at) <= new Date());
        return {
          application_id: r.id,
          // مفتاح مُوحَّد: تُعيده مسارات المقارنة/الطلبات جميعاً، فلا يختلط id الطلب بـ id المرشح
          id: r.id,
          reference_no: r.reference_no,
          full_name: r.full_name,
          city: r.city,
          years_experience: r.years_experience,
          qualification: r.qualification,
          specialization: r.specialization,
          status: r.status,
          scores: {
            cv_match: Number(r.cv_match_score),
            assessment: Number(r.assessment_score),
            ai_overall: Number(r.ai_overall_score),
            committee_avg: Number(r.committee_avg_score),
            final_weighted: Number(r.final_weighted_score),
            voice_bonus: Number(r.voice_bonus_score)
          },
          committee: {
            criteria_averages: {
              technical_competence: avg('technical_competence'),
              communication_persuasion: avg('communication_persuasion'),
              problem_solving: avg('problem_solving'),
              cultural_fit: avg('cultural_fit'),
              portfolio_practical: avg('portfolio_practical')
            },
            evaluators: evals
          },
          attendance: {
            scheduled_date: r.scheduled_date,
            start_time: r.start_time,
            booking_status: r.booking_status,
            interview_mode: r.interview_mode,
            punctuality_minutes: r.punctuality_minutes == null ? null : Number(r.punctuality_minutes),
            checked_in: Boolean(r.checked_in_at),
            actual_call_minutes: r.actual_call_minutes == null ? null : Number(r.actual_call_minutes)
          },
          // وجود رقم هوية مسجَّل (علم فقط — الرقم نفسه لا يُعاد)
          has_national_id: Boolean(r.national_id_on_file),
          // ملخص السيرة كما يظهر في المصفوفة (مقتطف نصي، لا الملف كاملاً)
          cv_summary: String(r.cv_excerpt || '').replace(/\s+/g, ' ').trim(),
          // خلاصة توصيات اللجنة: آخر توصية لكل عضو + المتوسط العددي
          recommendation_summary: {
            total_evaluators: evals.length,
            latest: evals.slice(0, 3).map((e) => ({
              evaluator_name: e.evaluator_name,
              evaluator_role: e.evaluator_role,
              recommendation: e.recommendation,
              notes: e.notes,
              total_percentage: e.total_percentage
            }))
          },
          voice_pitch: {
            available: voiceAvailable,
            stream_url: voiceAvailable ? `/api/applications/${r.id}/voice-stream` : null
          }
        };
      });

      // ترتيب تنازلي بالدرجة النهائية ليسهّل القرار
      candidates.sort((a, b) => b.scores.final_weighted - a.scores.final_weighted);

      res.json({
        job: {
          id: jobIds[0],
          code: rows[0].job_code,
          title: rows[0].job_title
        },
        count: candidates.length,
        can_issue_offers: OFFER_ISSUE_ROLES.includes(req.user.role),
        candidates
      });
    } catch (err) {
      res.status(500).json({ error: err.message, code: 'COMPARE_FAILED' });
    }
  });

  // ---------------------------------------------------------------------------
  // 2) قراءة قالب العرض
  // ---------------------------------------------------------------------------
  router.get('/offers/template', requireAuth(OFFER_ISSUE_ROLES), async (_req, res) => {
    try {
      const { rows } = await query(
        "SELECT setting_value FROM system_settings WHERE setting_key = 'offer_template_config'"
      );
      const template = offerPdf.normalizeTemplate(rows[0] ? rows[0].setting_value : null);
      res.json({ template, editable: true });
    } catch (err) {
      res.status(500).json({ error: err.message, code: 'TEMPLATE_READ_FAILED' });
    }
  });

  // ---------------------------------------------------------------------------
  // 3) تعديل القالب
  // ---------------------------------------------------------------------------
  router.put('/offers/template', requireAuth(OFFER_ISSUE_ROLES), async (req, res) => {
    try {
      const incoming = req.body && req.body.template ? req.body.template : req.body;
      if (!incoming || typeof incoming !== 'object') {
        return res.status(400).json({ error: 'بنية القالب غير صالحة.', code: 'INVALID_TEMPLATE' });
      }
      const current = await query(
        "SELECT setting_value FROM system_settings WHERE setting_key = 'offer_template_config'"
      );
      const merged = offerPdf.normalizeTemplate({
        ...(current.rows[0] ? current.rows[0].setting_value : {}),
        ...incoming
      });
      // نصوص القالب تُنقّى من محارف التحكم قبل الحفظ
      for (const k of Object.keys(merged)) {
        if (typeof merged[k] === 'string') merged[k] = offerPdf.sanitizeText(merged[k], 400);
      }
      await query(
        `UPDATE system_settings
         SET setting_value = $1::jsonb, updated_by = $2, updated_at = NOW()
         WHERE setting_key = 'offer_template_config'`,
        [JSON.stringify(merged), req.user.full_name]
      );
      await logAudit({
        actor: req.user.full_name,
        actorRole: req.user.role,
        action: 'OFFER_TEMPLATE_UPDATED',
        entityType: 'system_settings',
        entityId: 'offer_template_config',
        metadata: { keys: Object.keys(incoming).slice(0, 20) },
        ipAddress: req.ip
      }).catch(() => {});
      res.json({ message: 'تم تحديث قالب العرض.', template: merged });
    } catch (err) {
      res.status(500).json({ error: err.message, code: 'TEMPLATE_UPDATE_FAILED' });
    }
  });

  // ---------------------------------------------------------------------------
  // 4) إصدار عرض وظيفي
  // ---------------------------------------------------------------------------
  router.post('/offers', requireAuth(OFFER_ISSUE_ROLES), async (req, res) => {
    const client = await pool.connect();
    let released = false;
    try {
      const body = req.body || {};
      const applicationId = safeInt(body.application_id);
      const basicSalary = Number(body.basic_salary);
      const housing = body.housing_allowance === undefined ? 0 : Number(body.housing_allowance);
      const transport = body.transport_allowance === undefined ? 0 : Number(body.transport_allowance);
      const others = body.other_allowances === undefined ? 0 : Number(body.other_allowances);
      const startDate = String(body.expected_start_date || '');
      const validityDays = safeInt(body.validity_days, 14);

      if (!Number.isInteger(applicationId) || applicationId <= 0) {
        return res.status(400).json({ error: 'معرّف الطلب مطلوب.', code: 'APPLICATION_ID_REQUIRED' });
      }
      if (!Number.isFinite(basicSalary) || basicSalary < 0 ||
          !Number.isFinite(housing) || housing < 0 ||
          !Number.isFinite(transport) || transport < 0 ||
          !Number.isFinite(others) || others < 0) {
        return res.status(400).json({ error: 'قيم الرواتب والبدلات يجب أن تكون أرقاماً غير سالبة.', code: 'INVALID_SALARY' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
        return res.status(400).json({ error: 'تاريخ المباشرة مطلوب بصيغة YYYY-MM-DD.', code: 'INVALID_START_DATE' });
      }

      const appRes = await client.query(
        `SELECT a.id, a.reference_no, a.status, c.full_name, j.title AS job_title, j.department
         FROM applications a
         JOIN candidates c ON c.id = a.candidate_id
         JOIN jobs j ON j.id = a.job_id
         WHERE a.id = $1`,
        [applicationId]
      );
      if (!appRes.rows.length) {
        return res.status(404).json({ error: 'الطلب غير موجود.', code: 'APPLICATION_NOT_FOUND' });
      }
      const app = appRes.rows[0];

      if (['rejected', 'failed_assessment', 'assessment_pending'].includes(app.status)) {
        return res.status(400).json({
          error: 'لا يمكن إصدار عرض وظيفي لهذا الطلب في حالته الحالية.',
          code: 'APPLICATION_NOT_OFFERABLE',
          status: app.status
        });
      }

      const existing = await client.query(
        'SELECT id, offer_ref, offer_status FROM job_offers WHERE application_id = $1',
        [applicationId]
      );
      if (existing.rows.length) {
        return res.status(409).json({
          error: 'يوجد عرض وظيفي لهذا الطلب بالفعل.',
          code: 'OFFER_ALREADY_EXISTS',
          offer_ref: existing.rows[0].offer_ref,
          offer_status: existing.rows[0].offer_status
        });
      }

      const tplRes = await client.query(
        "SELECT setting_value FROM system_settings WHERE setting_key = 'offer_template_config'"
      );
      const template = offerPdf.normalizeTemplate(tplRes.rows[0] ? tplRes.rows[0].setting_value : null);

      // ---------------------------------------------------------------------
      // تخصيص المرجع: ذري بالكامل عبر تسلسل PostgreSQL.
      // كان `MAX(id)+1` يُقرأ خارج المعاملة، فعمليتان متزامنتان تحصلان على نفس
      // الرقم ⇒ نفس اسم الملف ⇒ يكتب أحدهما فوق الآخر قبل أن يرفض القيد.
      // nextval() ذري ولا يحجب القراءة؛ وUNIQUE(offer_ref) يبقى خط الدفاع الأخير.
      // ولا يوجد أي مسار يكتب ملفاً قبل نجاح الإدخال.
      // ---------------------------------------------------------------------
      await client.query('BEGIN');
      const seqRes = await client.query("SELECT nextval('job_offers_ref_seq') AS next");
      const offerRef = buildOfferRef(Number(seqRes.rows[0].next));

      const token = generateOfferToken();
      const tokenHash = hashToken(token);

      const start = new Date(`${startDate}T00:00:00Z`);
      const validUntil = new Date(start.getTime() + validityDays * 24 * 3600 * 1000);
      const validUntilStr = validUntil.toISOString().slice(0, 10);

      const offerData = {
        offer_ref: offerRef,
        candidate_name: app.full_name,
        job_title_snapshot: app.job_title,
        department_snapshot: app.department,
        issued_date: new Date().toISOString().slice(0, 10),
        expected_start_date: startDate,
        valid_until: validUntilStr,
        basic_salary: basicSalary,
        housing_allowance: housing,
        transport_allowance: transport,
        other_allowances: others,
        probation_days: safeInt(body.probation_days, template.default_probation_days || 90),
        annual_leave_days: safeInt(body.annual_leave_days, template.default_annual_leave_days || 21),
        special_terms: offerPdf.sanitizeText(body.special_terms, 1500)
      };

      const renderedHtml = offerPdf.buildOfferHtml(offerData, template);
      const pdfResult = await offerPdf.buildOfferPdf(offerData, template);

      const inserted = await client.query(
        `INSERT INTO job_offers (
           offer_ref, application_id, job_title_snapshot, department_snapshot,
           basic_salary, housing_allowance, transport_allowance, other_allowances,
           probation_days, annual_leave_days, expected_start_date, valid_until, special_terms,
           template_version, rendered_html, pdf_sha256,
           offer_token, offer_status, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12::date,$13,$14,$15,$16,$17,'issued',$18)
         RETURNING id, offer_ref, offer_status, total_monthly_salary, valid_until`,
        [
          offerRef, applicationId, app.job_title, app.department,
          basicSalary, housing, transport, others,
          offerData.probation_days, offerData.annual_leave_days, startDate, validUntilStr,
          offerData.special_terms || null, template.template_version,
          renderedHtml, pdfResult.sha256,
          tokenHash, req.user.full_name
        ]
      );

      // ---------------------------------------------------------------------
      // كتابة الملف: بعد نجاح الإدخال وقبل الـ COMMIT.
      // لو فشلت الكتابة نُرجِع المعاملة فلا يبقى صف يشير إلى ملف غير موجود.
      // العلم 'wx' يرفض الاستبدال: لا يمكن لأي عرض أن يطمس مستند عرض آخر.
      // المسار يحمل بصمة المحتوى أيضاً، فحتى لو تكرّر اسم مفترض يستحيل التعارض.
      // ---------------------------------------------------------------------
      const dir = ensureOffersDir();
      const fileName = `${offerRef}-${String(pdfResult.sha256).slice(0, 12)}.pdf`;
      const absPdfPath = path.join(dir, fileName);
      try {
        fs.writeFileSync(absPdfPath, pdfResult.bytes, { flag: 'wx' });
      } catch (fsErr) {
        if (fsErr && fsErr.code === 'EEXIST') {
          await client.query('ROLLBACK');
          released = false;
          return res.status(409).json({
            error: 'تعذّر حجز مسار ملف فريد للعرض. أعد المحاولة.',
            code: 'OFFER_PDF_PATH_CONFLICT'
          });
        }
        await client.query('ROLLBACK');
        released = false;
        return res.status(500).json({
          error: 'تعذّر تخزين ملف العرض الوظيفي. لم يُسجَّل أي عرض.',
          code: 'OFFER_PDF_WRITE_FAILED'
        });
      }
      const storedPath = path.posix.join('offers', fileName);

      await client.query(
        'UPDATE job_offers SET pdf_stored_path = $2, updated_at = NOW() WHERE id = $1',
        [inserted.rows[0].id, storedPath]
      );

      await client.query(
        "UPDATE applications SET status = 'offered', updated_at = NOW() WHERE id = $1",
        [applicationId]
      );

      // الحدث يُكتب داخل نفس المعاملة — n8n لا يُفشل الإصدار
      await safeEnqueueEvent(client, {
          eventType: 'offer.issued',
          aggregateType: 'job_offer',
          aggregateId: String(inserted.rows[0].id),
          payload: {
            offer_ref: offerRef,
            application_id: applicationId,
            reference_no: app.reference_no,
            candidate_name: app.full_name,
            job_title: app.job_title,
            department: app.department,
            total_monthly_salary: Number(inserted.rows[0].total_monthly_salary),
            expected_start_date: startDate,
            valid_until: validUntilStr,
            offer_status: 'issued',
            pdf_sha256: pdfResult.sha256
          },
          idempotencyKey: `offer.issued:${offerRef}`
        });

      await client.query('COMMIT');
      released = false;

      await logAudit({
        actor: req.user.full_name,
        actorRole: req.user.role,
        action: 'OFFER_ISSUED',
        entityType: 'job_offer',
        entityId: inserted.rows[0].id,
        metadata: { offer_ref: offerRef, pdf_sha256: pdfResult.sha256, salary: basicSalary },
        ipAddress: req.ip
      }).catch(() => {});

      res.status(201).json({
        message: 'تم إصدار العرض الوظيفي وتوليد ملف PDF.',
        offer: {
          id: inserted.rows[0].id,
          offer_ref: offerRef,
          offer_status: 'issued',
          total_monthly_salary: Number(inserted.rows[0].total_monthly_salary),
          valid_until: validUntilStr,
          pdf_sha256: pdfResult.sha256,
          pdf_bytes: pdfResult.bytes.length,
          // الرابط الكامل يُعاد مرة واحدة فقط عند الإصدار (لا يُخزَّن خاماً)
          candidate_url: `/OfferView.dc.html?ot=${token}`
        },
        // تنبيه صريح: لا إرسال تلقائي — على المنسق تسليم الرابط يدوياً
        delivery: {
          automatic_send: false,
          note: 'لم يُرسل شيء للمرشح تلقائياً. انسخ الرابط وسلّمه عبر واتساب يدوياً (Dry-Run قائم).'
        }
      });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_e) { /* ignore */ }
      res.status(500).json({ error: err.message, code: 'OFFER_ISSUE_FAILED' });
    } finally {
      if (!released) client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // 5) قائمة العروض
  // ---------------------------------------------------------------------------
  router.get('/offers', requireAuth(), async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT o.id, o.offer_ref, o.offer_status, o.total_monthly_salary, o.expected_start_date,
                o.valid_until, o.signed_at, o.decline_reason, o.n8n_sync_status, o.created_by, o.created_at,
                o.pdf_sha256, o.pdf_stored_path,
                a.reference_no, a.status AS application_status,
                c.full_name, j.title AS job_title
         FROM job_offers o
         JOIN applications a ON a.id = o.application_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN jobs j ON j.id = a.job_id
         ORDER BY o.created_at DESC
         LIMIT 200`
      );
      res.json({
        offers: rows.map((r) => ({
          ...r,
          total_monthly_salary: Number(r.total_monthly_salary),
          // مسار التخزين داخلي ولا يُكشف للمتصفح
          pdf_stored_path: undefined,
          has_pdf: Boolean(r.pdf_sha256)
        })),
        can_issue: OFFER_ISSUE_ROLES.includes(req.user.role)
      });
    } catch (err) {
      res.status(500).json({ error: err.message, code: 'OFFERS_LIST_FAILED' });
    }
  });

  // ---------------------------------------------------------------------------
  // 6) بث ملف PDF — المسار الوحيد المصرّح به لتسليم مستند العرض
  //    يستخدمه: المسار الموظفي (جلسة) والمسار العام (توكن العرض).
  //    المسار المخزَّن نسبي داخل مجلد العروض حصراً، ويُرفض أي خروج عنه.
  // ---------------------------------------------------------------------------
  function streamStoredPdf(res, row) {
    if (!row || !row.pdf_stored_path) {
      return res.status(404).json({ error: 'ملف العرض غير موجود.', code: 'OFFER_PDF_NOT_FOUND' });
    }
    const offersRoot = path.resolve(ensureOffersDir());
    const base = path.resolve(offersRoot, '..');
    const full = path.resolve(base, row.pdf_stored_path);
    // منع الخروج من مجلد العروض (../ أو مسار مطلق)
    if (!full.startsWith(offersRoot + path.sep)) {
      return res.status(400).json({ error: 'مسار غير مسموح.', code: 'PATH_NOT_ALLOWED' });
    }
    if (!fs.existsSync(full)) {
      return res.status(404).json({ error: 'ملف العرض غير موجود على القرص.', code: 'OFFER_PDF_MISSING' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${row.offer_ref}.pdf"`);
    res.setHeader('X-Content-SHA256', row.pdf_sha256 || '');
    // منع تخزين الوسيط للنسخة: المستند يخضع لصلاحية العرض
    res.setHeader('Cache-Control', 'private, no-store');
    return fs.createReadStream(full).pipe(res);
  }

  router.get('/offers/:id/pdf', requireAuth(OFFER_ISSUE_ROLES), async (req, res) => {
    try {
      const id = safeInt(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'معرّف غير صالح.', code: 'INVALID_OFFER_ID' });
      }
      const { rows } = await query(
        'SELECT offer_ref, pdf_stored_path, pdf_sha256 FROM job_offers WHERE id = $1',
        [id]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'ملف العرض غير موجود.', code: 'OFFER_PDF_NOT_FOUND' });
      }
      await logAudit({
        actor: req.user.full_name,
        actorRole: req.user.role,
        action: 'OFFER_PDF_DOWNLOADED',
        entityType: 'job_offer',
        entityId: id,
        metadata: { offer_ref: rows[0].offer_ref },
        ipAddress: req.ip
      }).catch(() => {});
      return streamStoredPdf(res, rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message, code: 'OFFER_PDF_FAILED' });
    }
  });

  // ---------------------------------------------------------------------------
  // 7) عرض المرشح العام (بتوكن offer_pass)
  // ---------------------------------------------------------------------------
  async function loadByToken(token) {
    if (!isValidTokenShape(token)) return null;
    const { rows } = await query(
      `SELECT o.*, c.full_name, c.national_id AS on_file_national_id,
              a.reference_no, j.title AS job_title, j.department
       FROM job_offers o
       JOIN applications a ON a.id = o.application_id
       JOIN candidates c ON c.id = a.candidate_id
       JOIN jobs j ON j.id = a.job_id
       WHERE o.offer_token = $1`,
      [hashToken(token)]
    );
    return rows[0] || null;
  }

  // ---------------------------------------------------------------------------
  // 6-ب) تنزيل PDF بتوكن العرض — للمرشح نفسه فقط.
  //      التوكن 256-بت ويُطابق بصمة مخزَّنة، فلا يكشف عرض غيره.
  //      لا يكشف المسار الداخلي ولا يسمح بالوصول عبر /uploads/offers/*.
  // ---------------------------------------------------------------------------
  router.get('/public/offers/:ot/pdf', async (req, res) => {
    try {
      const offer = await loadByToken(req.params.ot);
      if (!offer) {
        return res.status(404).json({ error: 'رابط العرض غير صالح.', code: 'OFFER_TOKEN_INVALID' });
      }
      await logAudit({
        actor: offer.full_name,
        actorRole: 'candidate',
        action: 'OFFER_PDF_DOWNLOADED_BY_CANDIDATE',
        entityType: 'job_offer',
        entityId: offer.id,
        metadata: { offer_ref: offer.offer_ref },
        ipAddress: req.ip
      }).catch(() => {});
      return streamStoredPdf(res, offer);
    } catch (err) {
      res.status(500).json({ error: err.message, code: 'OFFER_PDF_FAILED' });
    }
  });

  router.get('/public/offers/:ot', async (req, res) => {
    try {
      const offer = await loadByToken(req.params.ot);
      if (!offer) {
        return res.status(404).json({ error: 'رابط العرض غير صالح.', code: 'OFFER_TOKEN_INVALID' });
      }
      const expired = offer.valid_until && new Date(offer.valid_until) < new Date(new Date().toISOString().slice(0, 10));
      const effectiveStatus = (offer.offer_status === 'issued' && expired) ? 'expired' : offer.offer_status;

      res.json({
        offer: {
          offer_ref: offer.offer_ref,
          offer_status: effectiveStatus,
          candidate_name: offer.full_name,
          job_title: offer.job_title_snapshot,
          department: offer.department_snapshot,
          expected_start_date: offer.expected_start_date,
          valid_until: offer.valid_until,
          basic_salary: Number(offer.basic_salary),
          housing_allowance: Number(offer.housing_allowance),
          transport_allowance: Number(offer.transport_allowance),
          other_allowances: Number(offer.other_allowances),
          total_monthly_salary: Number(offer.total_monthly_salary),
          probation_days: offer.probation_days,
          annual_leave_days: offer.annual_leave_days,
          special_terms: offer.special_terms,
          signed_at: offer.signed_at,
          candidate_signed_name: offer.candidate_signed_name,
          // لا يُعاد الرقم المسجَّل أبداً — فقط ما إذا كان مطلوباً مطابقته
          national_id_on_file: Boolean(offer.on_file_national_id),
          can_respond: effectiveStatus === 'issued'
        },
        company: await (async () => {
          const t = await query("SELECT setting_value FROM system_settings WHERE setting_key = 'offer_template_config'");
          const tpl = offerPdf.normalizeTemplate(t.rows[0] ? t.rows[0].setting_value : null);
          return { name: tpl.company_name, legal_name: tpl.company_legal_name, address: tpl.company_address };
        })()
      });
    } catch (err) {
      res.status(500).json({ error: err.message, code: 'OFFER_VIEW_FAILED' });
    }
  });

  router.post('/public/offers/:ot/respond', async (req, res) => {
    const client = await pool.connect();
    try {
      const offer = await loadByToken(req.params.ot);
      if (!offer) {
        return res.status(404).json({ error: 'رابط العرض غير صالح.', code: 'OFFER_TOKEN_INVALID' });
      }
      const body = req.body || {};
      const decision = String(body.decision || '');
      if (!['accept', 'decline'].includes(decision)) {
        return res.status(400).json({ error: 'القرار يجب أن يكون accept أو decline.', code: 'INVALID_DECISION' });
      }

      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT id, offer_status, valid_until, candidate_signed_name, signed_at
         FROM job_offers WHERE id = $1 FOR UPDATE`,
        [offer.id]
      );
      const row = locked.rows[0];

      if (row.offer_status !== 'issued') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'لا يمكن الرد على هذا العرض في حالته الحالية.',
          code: 'OFFER_NOT_ACTIONABLE',
          offer_status: row.offer_status
        });
      }
      if (row.valid_until && new Date(row.valid_until) < new Date(new Date().toISOString().slice(0, 10))) {
        await client.query("UPDATE job_offers SET offer_status='expired', updated_at=NOW() WHERE id=$1", [row.id]);
        await client.query('COMMIT');
        return res.status(409).json({ error: 'انتهت صلاحية العرض.', code: 'OFFER_EXPIRED' });
      }

      if (decision === 'accept') {
        const signedName = offerPdf.sanitizeText(body.signed_name, 180);
        const nationalId = offerPdf.sanitizeText(body.national_id, 30);
        const agreedStart = String(body.agreed_start_date || '');
        const expectedName = offerPdf.sanitizeText(offer.full_name, 180);

        if (!signedName || !nationalId) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'الاسم الرباعي ورقم الهوية مطلوبان للقبول.', code: 'SIGNATURE_FIELDS_REQUIRED' });
        }
        // الاسم يجب أن يطابق اسم المرشح في السجل (مقارنة مُطبَّعة)
        const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
        if (norm(signedName) !== norm(expectedName)) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'الاسم المُدخل لا يطابق اسم المرشح المسجل في العرض.',
            code: 'SIGNED_NAME_MISMATCH'
          });
        }
        if (!/^[0-9]{10}$/.test(nationalId)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'رقم الهوية/الإقامة يجب أن يكون 10 أرقام.', code: 'INVALID_NATIONAL_ID' });
        }
        // إن كان للمرشح رقم هوية مسجَّل في ملفه، يجب أن يطابق ما أدخله عند التوقيع
        const onFile = offer.on_file_national_id ? String(offer.on_file_national_id).trim() : '';
        if (onFile && onFile !== nationalId) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'رقم الهوية المُدخل لا يطابق الرقم المسجل في ملفك.',
            code: 'NATIONAL_ID_MISMATCH'
          });
        }
        if (agreedStart && !/^\d{4}-\d{2}-\d{2}$/.test(agreedStart)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'تاريخ المباشرة غير صالح.', code: 'INVALID_AGREED_DATE' });
        }

        await client.query(
          `UPDATE job_offers
           SET offer_status='accepted', candidate_signed_name=$2, candidate_national_id=$3,
               candidate_agreed_start_date=$4::date, signed_at=NOW(), signer_ip=$5, updated_at=NOW()
           WHERE id=$1`,
          [row.id, signedName, nationalId, agreedStart || offer.expected_start_date, String(req.ip || '').slice(0, 64)]
        );
        await client.query(
          "UPDATE applications SET status='hired', updated_at=NOW() WHERE id=$1",
          [offer.application_id]
        );
        await safeEnqueueEvent(client, {
            eventType: 'offer.accepted',
            aggregateType: 'job_offer',
            aggregateId: String(row.id),
            payload: {
              offer_ref: offer.offer_ref,
              application_id: offer.application_id,
              reference_no: offer.reference_no,
              candidate_name: offer.full_name,
              job_title: offer.job_title_snapshot,
              department: offer.department_snapshot,
              total_monthly_salary: Number(offer.total_monthly_salary),
              signed_name: signedName,
              agreed_start_date: agreedStart || offer.expected_start_date,
              offer_status: 'accepted',
              // الحالة النهائية للطلب — يحتاجها n8n لبدء إجراءات المباشرة
              application_status: 'hired'
            },
            idempotencyKey: `offer.accepted:${offer.offer_ref}`
          });
        await client.query('COMMIT');

        await logAudit({
          actor: offer.full_name,
          actorRole: 'candidate',
          action: 'OFFER_ACCEPTED',
          entityType: 'job_offer',
          entityId: row.id,
          metadata: { offer_ref: offer.offer_ref },
          ipAddress: req.ip
        }).catch(() => {});

        return res.json({
          message: 'تم قبول العرض وتوقيعه إلكترونياً. مبروك!',
          offer_status: 'accepted',
          application_status: 'hired',
          signed_at: new Date().toISOString()
        });
      }

      // اعتذار
      const reason = offerPdf.sanitizeText(body.decline_reason, 500);
      await client.query(
        `UPDATE job_offers
         SET offer_status='declined', decline_reason=$2, signed_at=NOW(), signer_ip=$3, updated_at=NOW()
         WHERE id=$1`,
        [row.id, reason || null, String(req.ip || '').slice(0, 64)]
      );
      await client.query(
        "UPDATE applications SET status='offer_declined', updated_at=NOW() WHERE id=$1",
        [offer.application_id]
      );
      await safeEnqueueEvent(client, {
          eventType: 'offer.declined',
          aggregateType: 'job_offer',
          aggregateId: String(row.id),
          payload: {
            offer_ref: offer.offer_ref,
            application_id: offer.application_id,
            reference_no: offer.reference_no,
            candidate_name: offer.full_name,
            decline_reason: reason || null,
            offer_status: 'declined'
          },
          idempotencyKey: `offer.declined:${offer.offer_ref}`
        });
      await client.query('COMMIT');

      await logAudit({
        actor: offer.full_name,
        actorRole: 'candidate',
        action: 'OFFER_DECLINED',
        entityType: 'job_offer',
        entityId: row.id,
        metadata: { offer_ref: offer.offer_ref, has_reason: Boolean(reason) },
        ipAddress: req.ip
      }).catch(() => {});

      return res.json({
        message: 'تم تسجيل اعتذارك عن العرض. شكراً لتواصلك.',
        offer_status: 'declined',
        application_status: 'offer_declined'
      });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_e) { /* ignore */ }
      res.status(500).json({ error: err.message, code: 'OFFER_RESPONSE_FAILED' });
    } finally {
      client.release();
    }
  });

  return router;
}

module.exports = {
  createOfferRoutes,
  generateOfferToken,
  hashToken,
  isValidTokenShape,
  buildOfferRef,
  OFFER_ISSUE_ROLES,
  MIN_COMPARE,
  MAX_COMPARE
};
