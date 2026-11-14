/**
 * مسارات حوكمة واتساب التشغيلية عبر WAHA (v2.3)
 * ---------------------------------------------------------------------------------
 * تُركَّب هذه المسارات من `server.js` بعد تهيئة `requireAuth` و`logAudit`، وتستقبل كائنات
 * الاعتماديات (deps) بدلاً من استيرادها مباشرة لتسهيل الاختبار المعزول.
 *
 * الضوابط المطبقة هنا:
 *  - `GET  /api/waha/status`            : قراءة فقط لحالة الجلسة والإعدادات وعدادات الإرسال (جميع الموظفين).
 *  - `PATCH /api/waha/config`           : تعديل dry_run / kill_switch / الحدود (super_admin + hr_coordinator).
 *  - `POST /api/waha/kill-switch`       : إيقاف فوري بنقرة واحدة (super_admin + hr_coordinator).
 *  - `POST /api/wa-messages/:id/dispatch-waha` : إرسال فردي معتمد من الطابور أو محاكاة جافة.
 *  - `GET  /api/waha/dry-run-outbox`    : استعراض آخر مظاريف الاختبار الجاف (بدون PII).
 *
 * قواعد صارمة:
 *  1) أي مسار إرسال فعلي محجوب تماماً عند `WAHA_DRY_RUN=true` (بيئة) أو `dry_run=true` (قاعدة بيانات).
 *  2) منع الإرسال الرجعي: لا تُرسل أي رسالة أُنشئت قبل `waha_activated_at` (حاجز القطع الزمني).
 *  3) `portal_recovery` محظورة نهائياً على مسار WAHA.
 *  4) حدود الإرسال: 6/دقيقة و25/ساعة افتراضياً + قاطع دائرة عند 3 أخطاء متتالية.
 *  5) السجلات لا تحمل أسراراً ولا أرقام مرشحين كاملة ولا نصوص رسائل.
 */
const crypto = require('crypto');
const express = require('express');

const WAHA_ROUTE_ROLES = Object.freeze(['super_admin', 'hr_coordinator']);
const WAHA_BLOCKED_TEMPLATES = Object.freeze(['portal_recovery']);
const WAHA_ALLOWED_TEMPLATES = Object.freeze([
  'interview_invite',
  'interview_inperson',
  'reschedule_notice',
  'confirm_booking',
  'reminder_day_before',
  'reminder_24h',
  'reminder_15m',
  'send_room_now',
  'pass_notification',
  'thank_followup',
  'custom'
]);
const DEFAULT_WAHA_CONFIG = Object.freeze({
  enabled: false,
  dry_run: true,
  kill_switch_tripped: false,
  waha_activated_at: null,
  max_per_minute: 6,
  max_per_hour: 25
});

function clampInt(value, { min, max, fallback }) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function buildDefaultWahaConfig() {
  return { ...DEFAULT_WAHA_CONFIG };
}

/** يقرأ إعدادات WAHA من system_settings بدمج آمن مع الافتراضات (لا يفشل أبداً بسبب صف مفقود) */
async function loadWahaConfig(query) {
  const { rows } = await query("SELECT setting_value FROM system_settings WHERE setting_key = 'waha_config'");
  const stored = rows[0]?.setting_value && typeof rows[0].setting_value === 'object' ? rows[0].setting_value : {};
  return {
    ...DEFAULT_WAHA_CONFIG,
    ...stored,
    dry_run: stored.dry_run === undefined ? true : Boolean(stored.dry_run),
    enabled: Boolean(stored.enabled),
    kill_switch_tripped: Boolean(stored.kill_switch_tripped),
    max_per_minute: clampInt(stored.max_per_minute, { min: 1, max: 6, fallback: DEFAULT_WAHA_CONFIG.max_per_minute }),
    max_per_hour: clampInt(stored.max_per_hour, { min: 1, max: 25, fallback: DEFAULT_WAHA_CONFIG.max_per_hour })
  };
}

/** حفظ ذري للإعدادات بدمج JSONB (لا يمس أي مفتاح آخر) */
async function saveWahaConfig(query, patch, actorName) {
  const { rows } = await query(
    `INSERT INTO system_settings (setting_key, setting_value, category, description, updated_by, updated_at)
     VALUES ('waha_config', $1::jsonb, 'security_governance', 'حوكمة بوابة WAHA التشغيلية (Dry-Run افتراضي + منع الرسائل الرجعية + مفتاح إيقاف فوري)', $2, NOW())
     ON CONFLICT (setting_key) DO UPDATE SET
       setting_value = COALESCE(system_settings.setting_value, '{}'::jsonb) || $1::jsonb,
       updated_by = $2,
       updated_at = NOW()
     RETURNING setting_value`,
    [JSON.stringify(patch), actorName]
  );
  return rows[0]?.setting_value || {};
}

/** عدد الرسائل التي خرجت فعلياً أو حُوكيت جفافاً خلال نافذة زمنية */
async function countRecentDispatches(query, { windowSql }) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS cnt
     FROM wa_messages
     WHERE last_attempt_at IS NOT NULL
       AND last_attempt_at > ${windowSql}`
  );
  return rows[0]?.cnt || 0;
}

function normalizePhoneDigits(rawPhone) {
  let digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('05') && digits.length === 10) digits = '966' + digits.slice(1);
  else if (digits.startsWith('5') && digits.length === 9) digits = '966' + digits;
  return digits;
}

function buildDispatchIdempotencyKey(message) {
  const parts = [
    'wa_msg',
    String(message.id),
    String(message.template_key || 'custom'),
    String(message.interview_id ?? 'nointerview'),
    message.created_at ? new Date(message.created_at).toISOString() : 'nocreated'
  ];
  return parts.join(':').slice(0, 140);
}

/**
 * يبني راوتر Express كامل لمسارات v2.3.
 * @param {object} deps
 * @param {Function} deps.query     دالة استعلام pg المشتركة
 * @param {object}   deps.pool      تجمّع اتصالات pg (للمعاملات الذرية)
 * @param {Function} deps.logAudit  دالة تدقيق مركزية
 * @param {Function} deps.requireAuth  مولّد حارس الصلاحيات
 * @param {object}   deps.wahaClient  عميل WAHA (services/wahaClient.js)
 */
function createWahaRoutes({ query, pool, logAudit, requireAuth, wahaClient }) {
  const router = express.Router();

  // ---------------------------------------------------------------------------
  // 1) حالة WAHA الحيّة والإعدادات وعدادات الإرسال (قراءة فقط لجميع الموظفين)
  // ---------------------------------------------------------------------------
  router.get('/waha/status', requireAuth(), async (req, res) => {
    try {
      const config = await loadWahaConfig(query);
      const envCfg = wahaClient.getWahaEnvConfig();

      // الفحص الشبكي لا يُنفَّذ إلا عند الطلب الصريح (?probe=1) لتجنّب أي حمل دوري على الحاوية
      const probe = String(req.query.probe || '') === '1' ? await wahaClient.probeWahaStatus() : null;

      const counts = await query(
        `SELECT
           COUNT(*) FILTER (WHERE last_attempt_at IS NOT NULL AND last_attempt_at > NOW() - INTERVAL '1 minute')::int AS sent_last_minute,
           COUNT(*) FILTER (WHERE last_attempt_at IS NOT NULL AND last_attempt_at > NOW() - INTERVAL '1 hour')::int AS sent_last_hour,
           COUNT(*) FILTER (WHERE delivery_channel = 'waha_dry_run')::int AS dry_run_total,
           COUNT(*) FILTER (WHERE delivery_channel = 'waha_live')::int AS live_total,
           COUNT(*) FILTER (WHERE last_error IS NOT NULL AND queue_status = 'failed')::int AS failed_total
         FROM wa_messages`
      );

      const effectiveDryRun = envCfg.envForcesDryRun || config.dry_run !== false || config.kill_switch_tripped || !config.enabled;
      const liveBlockedReason = envCfg.envForcesDryRun
        ? 'ENV_WAHA_DRY_RUN_TRUE'
        : config.dry_run
          ? 'DB_DRY_RUN_TRUE'
          : config.kill_switch_tripped
            ? 'KILL_SWITCH_TRIPPED'
            : !config.enabled
              ? 'WAHA_NOT_ENABLED'
              : null;

      res.json({
        mode: effectiveDryRun ? 'dry_run' : 'live',
        effective_dry_run: effectiveDryRun,
        live_send_blocked_reason: liveBlockedReason,
        env: {
          dry_run_locked: envCfg.envForcesDryRun,
          has_api_key: Boolean(envCfg.apiKey),
          has_webhook_secret: envCfg.hasWebhookSecret,
          session: envCfg.session
        },
        config: {
          enabled: config.enabled,
          dry_run: config.dry_run,
          kill_switch_tripped: config.kill_switch_tripped,
          waha_activated_at: config.waha_activated_at,
          max_per_minute: config.max_per_minute,
          max_per_hour: config.max_per_hour
        },
        counters: {
          ...(counts.rows[0] || {}),
          max_per_minute: config.max_per_minute,
          max_per_hour: config.max_per_hour
        },
        probe
      });
    } catch (err) {
      res.status(500).json({ error: err.message || 'تعذّر قراءة حالة WAHA.', code: 'WAHA_STATUS_FAILED' });
    }
  });

  // ---------------------------------------------------------------------------
  // 2) تعديل إعدادات الحوكمة (dry_run / kill_switch / الحدود) — مدير ومنسق فقط
  // ---------------------------------------------------------------------------
  router.patch('/waha/config', requireAuth(WAHA_ROUTE_ROLES), async (req, res) => {
    try {
      const body = req.body || {};
      const allowedKeys = ['dry_run', 'enabled', 'kill_switch_tripped', 'max_per_minute', 'max_per_hour'];
      const unknown = Object.keys(body).filter((k) => !allowedKeys.includes(k));
      if (unknown.length) {
        return res.status(400).json({
          error: `مفاتيح إعداد غير مسموحة: ${unknown.join(', ')}`,
          code: 'WAHA_CONFIG_INVALID_KEYS'
        });
      }
      if (!Object.keys(body).length) {
        return res.status(400).json({ error: 'لم يتم إرسال أي إعداد للتعديل.', code: 'WAHA_CONFIG_EMPTY' });
      }

      const envCfg = wahaClient.getWahaEnvConfig();
      const patch = {};

      if (body.dry_run !== undefined) {
        if (typeof body.dry_run !== 'boolean') {
          return res.status(400).json({ error: 'dry_run يجب أن تكون قيمة منطقية.', code: 'WAHA_CONFIG_INVALID_TYPE' });
        }
        // منع إطفاء Dry-Run من الواجهة أثناء فرضه في البيئة — يبقى القفل البيئي هو الأعلى دائماً
        if (body.dry_run === false && envCfg.envForcesDryRun) {
          return res.status(409).json({
            error: 'وضع الاختبار الجاف مفروض من متغير البيئة WAHA_DRY_RUN=true ولا يمكن تعطيله من الواجهة.',
            code: 'WAHA_DRY_RUN_ENV_LOCKED'
          });
        }
        patch.dry_run = body.dry_run;
      }
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') {
          return res.status(400).json({ error: 'enabled يجب أن تكون قيمة منطقية.', code: 'WAHA_CONFIG_INVALID_TYPE' });
        }
        // لا يمكن تفعيل القناة الحية بينما Kill-Switch مرفوع أو Dry-Run مفعّل
        if (body.enabled === true) {
          const current = await loadWahaConfig(query);
          const effectiveDryRun = envCfg.envForcesDryRun || (patch.dry_run !== undefined ? patch.dry_run : current.dry_run);
          if (current.kill_switch_tripped) {
            return res.status(409).json({
              error: 'لا يمكن تفعيل الإرسال الحيّ بينما مفتاح الإيقاف الفوري (Kill-Switch) مرفوع.',
              code: 'WAHA_KILL_SWITCH_TRIPPED'
            });
          }
          if (effectiveDryRun) {
            return res.status(409).json({
              error: 'لا يمكن تفعيل الإرسال الحيّ بينما وضع الاختبار الجاف (Dry-Run) مفعّل.',
              code: 'WAHA_DRY_RUN_ACTIVE'
            });
          }
          // يبقى التفعيل الحيّ محكوماً بموافقة المالك المنفصلة عبر متغير البيئة WAHA_LIVE_APPROVED=true
          if (String(process.env.WAHA_LIVE_APPROVED || '').toLowerCase() !== 'true') {
            return res.status(403).json({
              error: 'تفعيل الإرسال الحيّ يتطلب موافقة المالك الصريحة عبر WAHA_LIVE_APPROVED=true على الخادم.',
              code: 'WAHA_LIVE_NOT_APPROVED'
            });
          }
          patch.waha_activated_at = new Date().toISOString();
        }
        patch.enabled = body.enabled;
      }
      if (body.kill_switch_tripped !== undefined) {
        if (typeof body.kill_switch_tripped !== 'boolean') {
          return res.status(400).json({ error: 'kill_switch_tripped يجب أن تكون قيمة منطقية.', code: 'WAHA_CONFIG_INVALID_TYPE' });
        }
        patch.kill_switch_tripped = body.kill_switch_tripped;
        if (body.kill_switch_tripped === true) {
          // مفتاح الإيقاف يُطفئ القناة الحية فوراً
          patch.enabled = false;
        }
      }
      if (body.max_per_minute !== undefined) {
        patch.max_per_minute = clampInt(body.max_per_minute, { min: 1, max: 6, fallback: DEFAULT_WAHA_CONFIG.max_per_minute });
      }
      if (body.max_per_hour !== undefined) {
        patch.max_per_hour = clampInt(body.max_per_hour, { min: 1, max: 25, fallback: DEFAULT_WAHA_CONFIG.max_per_hour });
      }

      const saved = await saveWahaConfig(query, patch, req.user.full_name);
      const merged = { ...DEFAULT_WAHA_CONFIG, ...saved };

      await logAudit({
        actor: req.user.full_name,
        actorRole: req.user.role,
        action: patch.kill_switch_tripped === true ? 'WAHA_KILL_SWITCH_TRIPPED' : 'WAHA_CONFIG_UPDATED',
        entityType: 'waha_config',
        entityId: null,
        metadata: {
          changed_keys: Object.keys(patch),
          dry_run: merged.dry_run,
          enabled: merged.enabled,
          kill_switch_tripped: merged.kill_switch_tripped,
          max_per_minute: merged.max_per_minute,
          max_per_hour: merged.max_per_hour
        },
        ipAddress: req.ip
      });

      res.json({
        message: patch.kill_switch_tripped === true
          ? 'تم تفعيل مفتاح الإيقاف الفوري 🛑 وتحويل النظام للوضع اليدوي wa.me.'
          : 'تم تحديث إعدادات بوابة WAHA بنجاح.',
        config: merged,
        effective_dry_run: envCfg.envForcesDryRun || merged.dry_run !== false || merged.kill_switch_tripped || !merged.enabled
      });
    } catch (err) {
      res.status(500).json({ error: err.message, code: 'WAHA_CONFIG_UPDATE_FAILED' });
    }
  });

  // ---------------------------------------------------------------------------
  // 3) مفتاح الإيقاف الفوري (نقرة واحدة)
  // ---------------------------------------------------------------------------
  router.post('/waha/kill-switch', requireAuth(WAHA_ROUTE_ROLES), async (req, res) => {
    try {
      const saved = await saveWahaConfig(
        query,
        { kill_switch_tripped: true, enabled: false },
        req.user.full_name
      );
      await logAudit({
        actor: req.user.full_name,
        actorRole: req.user.role,
        action: 'WAHA_KILL_SWITCH_TRIPPED',
        entityType: 'waha_config',
        entityId: null,
        metadata: { source: 'kill_switch_endpoint', ip_hint: 'logged' },
        ipAddress: req.ip
      });
      res.json({
        message: 'تم إيقاف الإرسال الآلي فوراً 🛑 — النظام يعمل الآن بالوضع اليدوي wa.me فقط.',
        config: { ...DEFAULT_WAHA_CONFIG, ...saved },
        effective_dry_run: true
      });
    } catch (err) {
      res.status(500).json({ error: err.message, code: 'WAHA_KILL_SWITCH_FAILED' });
    }
  });

  // ---------------------------------------------------------------------------
  // 4) إرسال فردي معتمد من الطابور عبر WAHA (أو محاكاة جافة صارمة)
  // ---------------------------------------------------------------------------
  router.post('/wa-messages/:id/dispatch-waha', requireAuth(WAHA_ROUTE_ROLES), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'معرّف الرسالة غير صالح.', code: 'INVALID_WA_MESSAGE_ID' });
    }

    let client;
    let dispatchedMessageId = null;
    try {
      const config = await loadWahaConfig(query);
      const envCfg = wahaClient.getWahaEnvConfig();
      // أي حالة غير مطابقة (dry_run / kill-switch مرفوع / القناة غير مفعّلة) تُسقط النظام إلى الوضع اليدوي wa.me
      const effectiveDryRun = envCfg.envForcesDryRun
        || config.dry_run !== false
        || config.kill_switch_tripped
        || !config.enabled;

      client = await pool.connect();
      await client.query('BEGIN');

      // ترتيب الأقفال الموحّد: applications -> interviews -> wa_messages
      const preLookup = await client.query('SELECT id, interview_id, application_id FROM wa_messages WHERE id = $1', [id]);
      if (!preLookup.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'الرسالة غير موجودة في الطابور.', code: 'WA_MESSAGE_NOT_FOUND' });
      }
      const { interview_id: interviewId, application_id: applicationId } = preLookup.rows[0];

      if (applicationId) {
        await client.query('SELECT id FROM applications WHERE id = $1 FOR UPDATE', [applicationId]);
      }
      let interview = null;
      if (interviewId) {
        const intRes = await client.query('SELECT * FROM interviews WHERE id = $1 FOR UPDATE', [interviewId]);
        interview = intRes.rows[0] || null;
      }
      const msgRes = await client.query('SELECT * FROM wa_messages WHERE id = $1 FOR UPDATE', [id]);
      const message = msgRes.rows[0];

      const reject = async (status, error, code, extra = {}) => {
        await client.query('ROLLBACK').catch(() => {});
        return res.status(status).json({ error, code, ...extra });
      };

      if (WAHA_BLOCKED_TEMPLATES.includes(message.template_key)) {
        return reject(400, 'رسائل استعادة الوصول (portal_recovery) محظورة نهائياً على مسار WAHA ولا تُرسل إلا يدوياً.', 'WAHA_TEMPLATE_BLOCKED');
      }
      if (!WAHA_ALLOWED_TEMPLATES.includes(message.template_key)) {
        return reject(400, `قالب الرسالة (${message.template_key}) غير معتمد على مسار WAHA.`, 'WAHA_TEMPLATE_NOT_ALLOWED');
      }
      if (message.queue_status === 'cancelled') {
        return reject(400, 'هذه الرسالة ملغاة نهائياً ولا يمكن إرسالها.', 'WA_MESSAGE_CANCELLED');
      }
      if (message.queue_status !== 'queued') {
        return reject(400, `لا يمكن إرسال رسالة في الحالة (${message.queue_status})؛ يجب أن تكون في الطابور (queued).`, 'INVALID_WA_TRANSITION');
      }
      if (interview && interview.booking_status === 'cancelled') {
        return reject(400, 'الموعد المرتبط بهذه الرسالة ملغى؛ لا يمكن إرسال دعوة لموعد ملغى.', 'INTERVIEW_ALREADY_CANCELLED');
      }

      // حاجز القطع الزمني: لا إرسال رجعي لأي سجل أقدم من لحظة تفعيل WAHA (يُطبَّق حتى في المحاكاة الجافة)
      if (config.waha_activated_at) {
        const activatedAt = new Date(config.waha_activated_at).getTime();
        const createdAt = new Date(message.created_at).getTime();
        if (Number.isFinite(activatedAt) && Number.isFinite(createdAt) && createdAt < activatedAt) {
          return reject(
            409,
            'هذه الرسالة أُنشئت قبل لحظة تفعيل WAHA؛ يُمنع الإرسال الرجعي نهائياً وفق حاجز القطع الزمني.',
            'WAHA_RETROACTIVE_SEND_BLOCKED',
            { cutoff: config.waha_activated_at, message_created_at: message.created_at }
          );
        }
      }

      // القاطع الدائري: 3 أخطاء متتالية ترفع مفتاح الإيقاف تلقائياً
      const lastErrors = await client.query(
        `SELECT last_error FROM wa_messages
         WHERE last_attempt_at IS NOT NULL
           AND delivery_channel <> 'waha_dry_run'
         ORDER BY last_attempt_at DESC
         LIMIT 3`
      );
      const consecutiveErrors = lastErrors.rows.filter((r) => r.last_error).length;
      if (!effectiveDryRun && consecutiveErrors >= 3) {
        await client.query(
          `UPDATE system_settings
           SET setting_value = COALESCE(setting_value, '{}'::jsonb) || '{"kill_switch_tripped": true, "enabled": false}'::jsonb,
               updated_at = NOW()
           WHERE setting_key = 'waha_config'`
        );
        await client.query('COMMIT');
        await logAudit({
          actor: 'قاطع الدائرة التلقائي',
          actorRole: 'system',
          action: 'WAHA_CIRCUIT_BREAKER_TRIPPED',
          entityType: 'waha_config',
          entityId: null,
          metadata: { consecutive_errors: consecutiveErrors },
          ipAddress: req.ip
        });
        return res.status(409).json({
          error: 'رُفع مفتاح الإيقاف تلقائياً بعد 3 أخطاء إرسال متتالية؛ النظام يعمل الآن يدوياً عبر wa.me.',
          code: 'WAHA_CIRCUIT_BREAKER_TRIPPED'
        });
      }

      // حدود الإرسال الفاعلة (6/دقيقة و25/ساعة افتراضياً، وبحد أقصى صارم 6/25)
      const perMinute = await countRecentDispatches(client.query.bind(client), { windowSql: "NOW() - INTERVAL '1 minute'" });
      const perHour = await countRecentDispatches(client.query.bind(client), { windowSql: "NOW() - INTERVAL '1 hour'" });
      if (perMinute >= config.max_per_minute || perHour >= config.max_per_hour) {
        await client.query('ROLLBACK');
        return res.status(429).json({
          error: `تم بلوغ حد الإرسال (${config.max_per_minute} رسالة/دقيقة و${config.max_per_hour} رسالة/ساعة). حاول لاحقاً أو استخدم wa.me يدوياً.`,
          code: 'WAHA_RATE_LIMITED',
          counters: { sent_last_minute: perMinute, sent_last_hour: perHour }
        });
      }

      const normalizedPhone = normalizePhoneDigits(message.recipient_phone);
      if (normalizedPhone.length < 9) {
        return reject(400, 'رقم جوال المستلم غير صالح لتنسيق واتساب الدولي.', 'INVALID_WA_PHONE');
      }

      const idempotencyKey = message.idempotency_key || buildDispatchIdempotencyKey(message);
      dispatchedMessageId = id;

      // استدعاء العميل: يحمل حارساً مزدوجاً داخلياً لـ Dry-Run، فلا يخرج أي بايت للشبكة عند فعاليته
      const result = await wahaClient.sendOrSimulateWahaText({
        recipientPhone: normalizedPhone,
        text: message.message_body,
        idempotencyKey,
        effectiveDryRun,
        templateKey: message.template_key
      });

      const targetChannel = result.sent_live ? 'waha_live' : 'waha_dry_run';
      const nextStatus = result.sent_live ? 'sent' : message.queue_status;

      const updated = await client.query(
        `UPDATE wa_messages SET
           queue_status = $1::varchar,
           delivery_channel = $2::varchar,
           idempotency_key = COALESCE(idempotency_key, $3),
           external_message_id = $4,
           attempt_count = attempt_count + 1,
           last_attempt_at = NOW(),
           last_error = NULL,
           dry_run_payload = $5::jsonb,
           sent_by = CASE WHEN $1::varchar = 'sent' THEN $6 ELSE sent_by END,
           sent_at = CASE WHEN $1::varchar = 'sent' AND sent_at IS NULL THEN NOW() ELSE sent_at END
         WHERE id = $7
         RETURNING *`,
        [
          nextStatus,
          targetChannel,
          idempotencyKey,
          result.external_message_id,
          JSON.stringify(result.envelope),
          req.user.full_name,
          id
        ]
      );

      // في الوضع الحيّ فقط: تحديث حالة المقابلة إلى invitation_sent عند إرسال دعوة
      if (result.sent_live && interview && ['interview_invite', 'interview_inperson', 'reschedule_notice'].includes(message.template_key)
          && ['scheduled', 'rescheduled'].includes(interview.booking_status)) {
        await client.query(
          `UPDATE interviews SET booking_status = 'invitation_sent', updated_at = NOW()
           WHERE id = $1 AND booking_status IN ('scheduled', 'rescheduled')`,
          [interview.id]
        );
      }

      await client.query('COMMIT');

      await logAudit({
        actor: req.user.full_name,
        actorRole: req.user.role,
        action: result.sent_live ? 'WAHA_MESSAGE_DISPATCHED_LIVE' : 'WAHA_MESSAGE_DRY_RUN_LOGGED',
        entityType: 'wa_message',
        entityId: id,
        // لا نص رسالة، لا رقم كامل، لا سر — فقط معرّفات وحالة
        metadata: {
          template_key: message.template_key,
          delivery_channel: targetChannel,
          external_message_id: result.external_message_id,
          idempotency_key: idempotencyKey,
          interview_id: interview ? interview.id : null
        },
        ipAddress: req.ip
      });

      res.json({
        mode: result.mode,
        sent_live: result.sent_live,
        dry_run: !result.sent_live,
        message: updated.rows[0],
        envelope: result.envelope,
        notice: result.sent_live
          ? 'تم إرسال الرسالة فعلياً عبر WAHA وتوثيقها في الطابور.'
          : '🧪 وضع الاختبار الجاف: تمت محاكاة الإرسال وتسجيله فقط — لم يخرج أي طلب إلى واتساب.'
      });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      const code = err.code || 'WAHA_DISPATCH_FAILED';
      const status = code === 'INVALID_WA_PHONE' ? 400 : code === 'WAHA_UPSTREAM_ERROR' ? 502 : 500;

      // توثيق الفشل إلزامياً بعد التراجع: بدون ذلك لا يوجد سجل يفعّل القاطع الدائري (3 أخطاء متتالية)
      if (dispatchedMessageId && code === 'WAHA_UPSTREAM_ERROR') {
        const safeError = String(err.message || '')
          .replace(String(process.env.WAHA_API_KEY || '\u0000'), '[redacted]')
          .slice(0, 300);
        await query(
          `UPDATE wa_messages
           SET attempt_count = attempt_count + 1,
               last_attempt_at = NOW(),
               last_error = $1
           WHERE id = $2`,
          [safeError, dispatchedMessageId]
        ).catch(() => {});
        await logAudit({
          actor: req.user.full_name,
          actorRole: req.user.role,
          action: 'WAHA_DISPATCH_FAILED',
          entityType: 'wa_message',
          entityId: dispatchedMessageId,
          metadata: { error_code: code, upstream_status: err.upstreamStatus || null },
          ipAddress: req.ip
        }).catch(() => {});
      }

      res.status(status).json({ error: err.message, code });
    } finally {
      if (client) client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // 5) صندوق صادرات الاختبار الجاف (بدون PII) — للمراجعة قبل أي تفعيل حقيقي
  // ---------------------------------------------------------------------------
  router.get('/waha/dry-run-outbox', requireAuth(WAHA_ROUTE_ROLES), async (req, res) => {
    try {
      const limit = clampInt(req.query.limit, { min: 1, max: 100, fallback: 25 });
      const { rows } = await query(
        `SELECT
           wm.id,
           wm.template_key,
           wm.delivery_channel,
           wm.queue_status,
           wm.external_message_id,
           wm.attempt_count,
           wm.last_attempt_at,
           wm.dry_run_payload,
           (SELECT COUNT(*)::int FROM wa_messages) AS total_messages
         FROM wa_messages wm
         WHERE wm.delivery_channel = 'waha_dry_run'
         ORDER BY wm.last_attempt_at DESC NULLS LAST
         LIMIT $1`,
        [limit]
      );
      const config = await loadWahaConfig(query);
      const envCfg = wahaClient.getWahaEnvConfig();
      res.json({
        effective_dry_run: envCfg.envForcesDryRun || config.dry_run !== false || config.kill_switch_tripped || !config.enabled,
        env_locked: envCfg.envForcesDryRun,
        total_messages: rows[0]?.total_messages ?? 0,
        outbox: rows.map(({ total_messages, ...r }) => r)
      });
    } catch (err) {
      res.status(500).json({ error: err.message, code: 'WAHA_OUTBOX_FAILED' });
    }
  });

  // ---------------------------------------------------------------------------
  // 6) مستمع ردود المرشحين (webhook موقّع) — 1 تأكيد حضور / 2 طلب تعديل موعد
  // ---------------------------------------------------------------------------
  router.post('/webhooks/waha', async (req, res) => {
    try {
      const envCfg = wahaClient.getWahaEnvConfig();
      if (!envCfg.hasWebhookSecret) {
        return res.status(503).json({ error: 'لم يُضبط WAHA_WEBHOOK_SECRET على الخادم؛ الويب هوك معطّل.', code: 'WAHA_WEBHOOK_NOT_CONFIGURED' });
      }
      const provided = String(req.headers['x-waha-webhook-secret'] || '');
      const expected = envCfg.webhookSecret;
      const a = Buffer.from(provided);
      const b = Buffer.from(expected);
      const signatureOk = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!signatureOk) {
        return res.status(401).json({ error: 'توقيع الويب هوك غير صالح.', code: 'WAHA_WEBHOOK_UNAUTHORIZED' });
      }

      const body = req.body || {};
      const event = String(body.event || '');
      if (event !== 'message') {
        return res.status(202).json({ accepted: false, reason: 'EVENT_IGNORED' });
      }
      const payload = body.payload || {};
      const chatId = String(payload.from || '');
      if (!chatId.endsWith('@c.us')) {
        return res.status(202).json({ accepted: false, reason: 'NOT_DIRECT_CANDIDATE_CHAT' });
      }
      const senderDigits = normalizePhoneDigits(chatId.replace('@c.us', ''));
      const replyText = String(payload.body || '').trim();
      if (!['1', '2'].includes(replyText)) {
        return res.status(202).json({ accepted: false, reason: 'REPLY_NOT_ACTIONABLE' });
      }

      // مطابقة آخر مقابلة نشطة في حالة invitation_sent لهذا الرقم فقط
      const { rows } = await query(
        `SELECT i.id, i.booking_status, i.application_id
         FROM interviews i
         JOIN applications a ON a.id = i.application_id
         JOIN candidates c ON c.id = a.candidate_id
         WHERE regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') = $1
           AND i.booking_status = 'invitation_sent'
         ORDER BY i.scheduled_date DESC, i.start_time DESC, i.id DESC
         LIMIT 1`,
        [senderDigits]
      );
      if (!rows.length) {
        return res.status(202).json({ accepted: false, reason: 'NO_ACTIVE_INVITATION_FOR_SENDER' });
      }
      const interview = rows[0];

      if (replyText === '1') {
        await query(
          `UPDATE interviews SET booking_status = 'confirmed', updated_at = NOW()
           WHERE id = $1 AND booking_status = 'invitation_sent'`,
          [interview.id]
        );
        await query(
          `UPDATE wa_messages SET queue_status = 'confirmed'
           WHERE interview_id = $1 AND queue_status = 'sent'`,
          [interview.id]
        );
        await logAudit({
          actor: 'رد واتساب (المرشح)',
          actorRole: 'candidate_reply',
          action: 'WAHA_REPLY_CONFIRMED',
          entityType: 'interview',
          entityId: interview.id,
          metadata: { reply_code: '1', channel: 'waha_webhook' },
          ipAddress: req.ip
        });
        return res.json({ accepted: true, action: 'confirmed', interview_id: interview.id });
      }

      await query(
        `UPDATE interviews SET reschedule_requested = TRUE, reschedule_requested_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [interview.id]
      );
      await logAudit({
        actor: 'رد واتساب (المرشح)',
        actorRole: 'candidate_reply',
        action: 'WAHA_REPLY_RESCHEDULE_REQUESTED',
        entityType: 'interview',
        entityId: interview.id,
        metadata: { reply_code: '2', channel: 'waha_webhook' },
        ipAddress: req.ip
      });
      res.json({ accepted: true, action: 'reschedule_requested', interview_id: interview.id });
    } catch (err) {
      res.status(500).json({ error: err.message, code: 'WAHA_WEBHOOK_FAILED' });
    }
  });

  return router;
}

module.exports = {
  createWahaRoutes,
  buildDefaultWahaConfig,
  buildDispatchIdempotencyKey,
  loadWahaConfig,
  saveWahaConfig,
  normalizePhoneDigits,
  WAHA_ROUTE_ROLES,
  WAHA_BLOCKED_TEMPLATES,
  WAHA_ALLOWED_TEMPLATES,
  DEFAULT_WAHA_CONFIG
};
