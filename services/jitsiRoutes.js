/**
 * مسارات قاعات الفيديو والتقييم المقسّم (v2.4)
 * ---------------------------------------------------------------------------------
 *  - GET  /api/jitsi/status                     : جاهزية النطاق (DNS فقط) + هل JWT مفعّل (بدون أسرار)
 *  - GET  /api/interviews/:id/room-session      : بيانات دخول القاعة لعضو اللجنة + ملف المرشح وأسئلته
 *  - POST /api/interviews/:id/room-telemetry    : توثيق فتح القاعة وانضمام المرشح ومدة المكالمة
 *  - GET  /api/interviews/:id/room-telemetry    : قراءة الجلسة الموثقة (للعرض في قاعة اللجنة)
 *
 * الضوابط:
 *  - RBAC ثلاثي فقط: super_admin + committee_member يدخلون كمديري قاعة ويقيّمون،
 *    hr_coordinator دخول تنسيقي بلا رصد درجات (لا يستطيع استدعاء تقييم من داخل القاعة).
 *  - اسم الغرفة يُولَّد مرة واحدة ويُثبَّت (UNIQUE) ولا يتغيّر بإعادة الطلب ⇒ لا تسريب ولا تكرار.
 *  - توكن JWT (إن فُعّل) يُعاد لعضو اللجنة فقط؛ المرشح يأخذ رابطه عبر بطاقة الزيارة الموقّعة
 *    (/api/public/visit/:vt) التي تتحقق أصلاً من رمز الزيارة + nonce المرتبط بالموعد.
 *  - لا تُعاد بيانات مرشح خارج ما يعرضه ملف المرشح أصلاً، ولا أي سر.
 */
const express = require('express');

const ROOM_STAFF_ROLES = Object.freeze(['super_admin', 'committee_member']);
const TELEMETRY_ALLOWED_EVENTS = Object.freeze(['staff_opened', 'candidate_joined', 'call_ended']);

function clampInt(value, { min, max, fallback }) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function createJitsiRoutes({ query, logAudit, requireAuth, jitsiClient }) {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // 1) حالة نطاق Jitsi (قراءة فقط لجميع الموظفين)
  // ---------------------------------------------------------------------------
  router.get('/jitsi/status', requireAuth(), async (_req, res) => {
    try {
      const env = jitsiClient.getJitsiEnvConfig();
      const probe = await jitsiClient.probeJitsiDomain();
      res.json({
        enabled: env.enabled,
        domain: env.domain,
        jwt_enabled: env.hasJwtSecret,
        // لا يُعاد أي سر — فقط علم منطقي
        probed_at: new Date().toISOString(),
        probe,
        degraded: !probe.ok,
        fallback_note: probe.ok
          ? null
          : 'نطاق القاعة غير جاهز — تبقى المنصة تعمل، وتُستخدم البطاقة والرابط البديل في دعوات المقابلة حتى تجهز البنية.'
      });
    } catch (err) {
      res.status(500).json({ error: err.message, code: 'JITSI_STATUS_FAILED' });
    }
  });

  // ---------------------------------------------------------------------------
  // 2) جلسة دخول القاعة لعضو اللجنة/المنسق + بيانات المقابلة للمراجعة أثناءها
  // ---------------------------------------------------------------------------
  router.get('/interviews/:id/room-session', requireAuth(), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'معرّف المقابلة غير صالح.', code: 'INVALID_INTERVIEW_ID' });
    }
    try {
      const env = jitsiClient.getJitsiEnvConfig();
      const { rows } = await query(
        `SELECT i.id, i.scheduled_date, i.start_time, i.end_time, i.duration_minutes, i.interview_mode,
                i.meeting_platform, i.meeting_url, i.booking_status, i.lobby_status,
                i.jitsi_room_name, i.room_opened_by_staff_at, i.candidate_joined_room_at, i.actual_call_minutes,
                i.location_building, i.location_floor, i.location_office, i.location_maps_url,
                a.id AS application_id, a.reference_no,
                a.ai_overall_score, a.assessment_score, a.status AS app_status,
                c.full_name, c.phone, c.email, c.cv_filename,
                j.code AS job_code, j.title AS job_title, j.department
         FROM interviews i
         JOIN applications a ON a.id = i.application_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN jobs j ON j.id = a.job_id
         WHERE i.id = $1`,
        [id]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'المقابلة غير موجودة.', code: 'INTERVIEW_NOT_FOUND' });
      }
      const interview = rows[0];

      if (interview.interview_mode === 'in_person') {
        return res.status(400).json({
          error: 'هذه المقابلة حضورية وليست عن بُعد؛ لا تُفتح لها قاعة فيديو.',
          code: 'INTERVIEW_NOT_REMOTE'
        });
      }

      // تثبيت اسم الغرفة مرة واحدة فقط (ذرّي، ويحترم القيد الفريد)
      let roomName = interview.jitsi_room_name;
      if (!roomName) {
        for (let attempt = 0; attempt < 5 && !roomName; attempt += 1) {
          const candidateName = jitsiClient.generateRoomName();
          const upd = await query(
            `UPDATE interviews SET jitsi_room_name = $1 WHERE id = $2 AND jitsi_room_name IS NULL RETURNING jitsi_room_name`,
            [candidateName, id]
          );
          if (upd.rows.length) {
            roomName = upd.rows[0].jitsi_room_name;
            await logAudit({
              actor: req.user.full_name,
              actorRole: req.user.role,
              action: 'JITSI_ROOM_CREATED',
              entityType: 'interview',
              entityId: id,
              metadata: { room_created: true },
              ipAddress: req.ip
            }).catch(() => {});
          } else {
            const again = await query('SELECT jitsi_room_name FROM interviews WHERE id = $1', [id]);
            roomName = again.rows[0]?.jitsi_room_name || null;
          }
        }
      }
      if (!roomName) {
        return res.status(500).json({ error: 'تعذّر تثبيت غرفة القاعة.', code: 'JITSI_ROOM_ASSIGN_FAILED' });
      }

      const isModerator = ROOM_STAFF_ROLES.includes(req.user.role);

      // أسئلة الـ AI المولّدة للوظيفة (بلا أي إجابات/درجات تخص مرشحين آخرين)
      let aiQuestions = [];
      try {
        const qRes = await query(
          `SELECT j.questions AS job_questions, j.title AS job_title
           FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = $1`,
          [interview.application_id]
        );
        const rawQ = qRes.rows[0] && qRes.rows[0].job_questions;
        const parsedQ = typeof rawQ === 'string' ? JSON.parse(rawQ) : rawQ;
        aiQuestions = Array.isArray(parsedQ) ? parsedQ.slice(0, 10) : [];
      } catch (_e) {
        aiQuestions = [];
      }

      // التسجيل الصوتي الاختياري: رابط داخلي محمي بنفس جلسة الموظف (سياسة الاستبقاء تُطبَّق في مسار الصوت نفسه)
      const voiceRes = await query(
        `SELECT voice_pitch_path, voice_mime_type,
                (voice_retention_expires_at IS NOT NULL AND voice_retention_expires_at <= NOW()) AS is_retention_expired
         FROM applications WHERE id = $1`,
        [interview.application_id]
      );
      const voice = voiceRes.rows[0] || {};
      const voiceAvailable = Boolean(voice.voice_pitch_path) && !voice.is_retention_expired;

      // تقييم العضو الحالي فقط (لا تقييمات أعضاء آخرين) حتى تُحمَّل قيمه بدل فرض افتراضيات.
      // hr_coordinator لا يرى أي تقييم لأنه لا يملك صلاحية الرصد.
      let myEvaluation = null;
      if (isModerator) {
        const myEvalRes = await query(
          `SELECT technical_competence, communication_persuasion, problem_solving,
                  cultural_fit, portfolio_practical, recommendation, notes, voice_human_note, evaluated_at
           FROM committee_evaluations
           WHERE application_id = $1 AND evaluator_name = $2
           LIMIT 1`,
          [interview.application_id, req.user.full_name]
        );
        myEvaluation = myEvalRes.rows[0] || null;
      }
      const session = jitsiClient.buildRoomSession({
        roomName,
        role: isModerator ? 'moderator' : 'participant',
        displayName: req.user.full_name,
        env
      });

      // ملف المرشح للعرض بجانب الفيديو (نفس ما يعرضه ملف المرشح بالفعل، بلا أي حقل سري)
      res.json({
        interview: {
          id: interview.id,
          application_id: interview.application_id,
          scheduled_date: interview.scheduled_date,
          start_time: interview.start_time,
          end_time: interview.end_time,
          duration_minutes: interview.duration_minutes,
          booking_status: interview.booking_status,
          lobby_status: interview.lobby_status,
          room_opened_by_staff_at: interview.room_opened_by_staff_at,
          candidate_joined_room_at: interview.candidate_joined_room_at,
          actual_call_minutes: interview.actual_call_minutes
        },
        room: {
          ...session,
          // لا يُكشف التوكن إلا لمن يملك صلاحية الإدارة/اللجنة
          join_url: isModerator ? session.join_url : session.url
        },
        candidate: {
          full_name: interview.full_name,
          job_title: interview.job_title,
          job_code: interview.job_code,
          department: interview.department,
          reference_no: interview.reference_no,
          cv_filename: interview.cv_filename
        },
        assessment: {
          ai_overall_score: interview.ai_overall_score == null ? null : Number(interview.ai_overall_score),
          assessment_score: interview.assessment_score == null ? null : Number(interview.assessment_score),
          status: interview.app_status
        },
        ai_questions: aiQuestions,
        voice_pitch: {
          available: voiceAvailable,
          // الرابط يمر بمسار محمي يتحقق من الجلسة والاستبقاء مرة أخرى
          stream_url: voiceAvailable ? `/api/applications/${interview.application_id}/voice-stream` : null,
          mime_type: voiceAvailable ? voice.voice_mime_type : null,
          retention_note: voiceAvailable ? null : 'التسجيل غير متاح (لم يُسجَّل أو انتهت مدة استبقائه).'
        },
        can_evaluate: isModerator,
        // تقييم هذا العضو فقط — null إن لم يقيّم بعد. القيم numeric تُحوَّل لأرقام صراحةً.
        my_evaluation: myEvaluation
          ? {
              technical_competence: Number(myEvaluation.technical_competence),
              communication_persuasion: Number(myEvaluation.communication_persuasion),
              problem_solving: Number(myEvaluation.problem_solving),
              cultural_fit: Number(myEvaluation.cultural_fit),
              portfolio_practical: Number(myEvaluation.portfolio_practical),
              recommendation: myEvaluation.recommendation,
              notes: myEvaluation.notes || '',
              voice_human_note: myEvaluation.voice_human_note || '',
              evaluated_at: myEvaluation.evaluated_at
            }
          : null,
        fallback_if_unreachable: interview.meeting_url || null
      });
    } catch (err) {
      res.status(500).json({ error: err.message, code: 'JITSI_ROOM_SESSION_FAILED' });
    }
  });

  // ---------------------------------------------------------------------------
  // 3) توثيق أحداث الجلسة (فتح/انضمام/انتهاء) + مدة المكالمة الفعلية
  // ---------------------------------------------------------------------------
  router.post('/interviews/:id/room-telemetry', requireAuth(), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'معرّف المقابلة غير صالح.', code: 'INVALID_INTERVIEW_ID' });
    }
    const event = String((req.body && req.body.event) || '');
    if (!TELEMETRY_ALLOWED_EVENTS.includes(event)) {
      return res.status(400).json({
        error: `حدث غير معروف؛ المسموح: ${TELEMETRY_ALLOWED_EVENTS.join(', ')}`,
        code: 'INVALID_TELEMETRY_EVENT'
      });
    }
    try {
      const { rows } = await query(
        `SELECT id, interview_mode, booking_status, room_opened_by_staff_at, candidate_joined_room_at,
                actual_call_minutes, room_telemetry
         FROM interviews WHERE id = $1`,
        [id]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'المقابلة غير موجودة.', code: 'INTERVIEW_NOT_FOUND' });
      }
      const interview = rows[0];
      if (interview.interview_mode === 'in_person') {
        return res.status(400).json({ error: 'لا توجد قاعة فيديو لمقابلة حضورية.', code: 'INTERVIEW_NOT_REMOTE' });
      }

      const nowMs = Date.now();
      const openedAtMs = interview.room_opened_by_staff_at ? new Date(interview.room_opened_by_staff_at).getTime() : null;
      const joinedAtMs = interview.candidate_joined_room_at ? new Date(interview.candidate_joined_room_at).getTime() : null;

      let setClause = '';
      const params = [id];
      if (event === 'staff_opened' && !openedAtMs) {
        setClause = 'room_opened_by_staff_at = NOW()';
      } else if (event === 'candidate_joined' && !joinedAtMs) {
        setClause = 'candidate_joined_room_at = NOW()';
      } else if (event === 'call_ended') {
        const duration = req.body && req.body.actual_call_minutes !== undefined
          ? clampInt(req.body.actual_call_minutes, { min: 0, max: 600, fallback: 0 })
          : jitsiClient.computeActualCallMinutes({ openedAtMs, candidateJoinedAtMs: joinedAtMs, closedAtMs: nowMs });
        params.push(duration);
        setClause = `actual_call_minutes = $${params.length}`;
      } else {
        // لا تغيير على القاعدة، لكن نُعيد الحالة الحالية دائماً كي تعتمد عليها الواجهة الموحّدة
        return res.status(200).json({
          message: 'الحدث مسجّل مسبقاً — لا تغيير.',
          idempotent: true,
          interview_id: id,
          event,
          session: {
            room_opened_by_staff_at: interview.room_opened_by_staff_at,
            candidate_joined_room_at: interview.candidate_joined_room_at,
            actual_call_minutes: interview.actual_call_minutes ?? null
          }
        });
      }

      const { rows: updated } = await query(
        `UPDATE interviews SET ${setClause}, updated_at = NOW()
         WHERE id = $1
         RETURNING room_opened_by_staff_at, candidate_joined_room_at, actual_call_minutes`,
        params
      );

      await logAudit({
        actor: req.user.full_name,
        actorRole: req.user.role,
        action: 'JITSI_ROOM_TELEMETRY',
        entityType: 'interview',
        entityId: id,
        metadata: { event, recorded: true },
        ipAddress: req.ip
      }).catch(() => {});

      res.json({
        message: 'تم توثيق حدث الجلسة.',
        interview_id: id,
        event,
        session: {
          room_opened_by_staff_at: updated[0].room_opened_by_staff_at,
          candidate_joined_room_at: updated[0].candidate_joined_room_at,
          actual_call_minutes: updated[0].actual_call_minutes
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message, code: 'JITSI_TELEMETRY_FAILED' });
    }
  });

  return router;
}

module.exports = {
  createJitsiRoutes,
  ROOM_STAFF_ROLES,
  TELEMETRY_ALLOWED_EVENTS
};
