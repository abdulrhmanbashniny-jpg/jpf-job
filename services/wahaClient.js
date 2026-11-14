/**
 * عميل حوكمة واتساب التشغيلي عبر WAHA (v2.3)
 * ---------------------------------------------------------------------------------
 * يطبق بشكل صارم ضوابط الأمان السبعة لمرحلة v2.3:
 *  1) قفل WAHA_DRY_RUN=true افتراضياً — لا يخرج أي طلب إرسال فعلي ما لم يُرفع القفل
 *     من البيئة (`WAHA_DRY_RUN=false` صراحةً) **و** من الإعدادات في قاعدة البيانات معاً.
 *  2) فحص الجاهزية للقراءة فقط (GET /api/sessions) بمهلة 3 ثوانٍ دون أي إرسال.
 *  3) عدم تسريب أي سر أو بيانات مرشح إلى السجلات: لا تُطبع `WAHA_API_KEY`،
 *     ويُقنَّع رقم المستلم في كل رسالة خطأ أو سجل تشخيصي.
 *  4) حصر عنوان الاتصال في شبكة Docker الداخلية (SSRF guard) ما لم يُسمح صراحةً
 *     بمضيف محلي للاختبار المعزول عبر `WAHA_ALLOW_LOOPBACK_FOR_TESTS=1` في NODE_ENV=test فقط.
 *  5) مهلة إرسال 5 ثوانٍ وسقوط آمن دائماً إلى رابط `wa.me` اليدوي.
 */
const crypto = require('crypto');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '[::1]']);

/** يقنّع رقم الجوال بحيث لا يظهر في أي سجل أو رسالة خطأ أكثر من 4 أرقام */
function maskPhone(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.length <= 4) return '***';
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

/**
 * يتحقق من أن عنوان WAHA داخلي فعلاً (اسم حاوية/شبكة Docker) وليس عنواناً عاماً،
 * حماية من توجيه الطلبات إلى وجهة غير متوقعة (SSRF) عبر متغيرات البيئة.
 */
function assertInternalWahaUrl(rawUrl, { nodeEnv = process.env.NODE_ENV } = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch (_e) {
    throw Object.assign(new Error('عنوان WAHA_BASE_URL غير صالح.'), { code: 'INVALID_WAHA_BASE_URL' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw Object.assign(new Error('بروتوكول WAHA_BASE_URL يجب أن يكون http أو https فقط.'), { code: 'INVALID_WAHA_BASE_URL' });
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const allowLoopback = nodeEnv === 'test' && String(process.env.WAHA_ALLOW_LOOPBACK_FOR_TESTS || '') === '1';

  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
  const isPrivateIpv4 = isIpv4 && (() => {
    const octets = hostname.split('.').map((n) => parseInt(n, 10));
    if (octets.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
    const [a, b] = octets;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  })();

  // اسم حاوية/شبكة Docker = تسمية واحدة بلا نقاط (مثل waha-bbg7-waha-1) أو عنوان IPv4 خاص
  const isSingleLabelDockerHost = hostname.length > 0 && !hostname.includes('.') && !hostname.includes(':');
  const isInternal = isPrivateIpv4 || (isSingleLabelDockerHost && !LOOPBACK_HOSTS.has(hostname));

  if (!isInternal && !allowLoopback) {
    throw Object.assign(
      new Error('WAHA_BASE_URL يجب أن يشير إلى اسم حاوية/شبكة Docker داخلية أو عنوان خاص فقط؛ العناوين العامة أو المحلية ممنوعة.'),
      { code: 'WAHA_BASE_URL_NOT_INTERNAL' }
    );
  }
  return parsed;
}

function getWahaEnvConfig() {
  const baseUrl = String(process.env.WAHA_BASE_URL || 'http://waha-bbg7-waha-1:3000').replace(/\/+$/, '');
  const apiKey = String(process.env.WAHA_API_KEY || '').trim();
  const session = String(process.env.WAHA_SESSION || 'default').trim();
  // القفل البيئي الصارم: يبقى مفعّلاً ما لم يُضبط WAHA_DRY_RUN=false صراحةً في البيئة
  const envForcesDryRun = String(process.env.WAHA_DRY_RUN ?? 'true').trim().toLowerCase() !== 'false';
  const webhookSecret = String(process.env.WAHA_WEBHOOK_SECRET || '').trim();
  return { baseUrl, apiKey, session, envForcesDryRun, webhookSecret, hasWebhookSecret: Boolean(webhookSecret) };
}

function normalizePhoneDigits(rawPhone) {
  let digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('05') && digits.length === 10) {
    digits = '966' + digits.slice(1);
  } else if (digits.startsWith('5') && digits.length === 9) {
    digits = '966' + digits;
  }
  return digits;
}

function toWahaChatId(rawPhone) {
  const digits = normalizePhoneDigits(rawPhone);
  if (digits.length < 9 || digits.length > 15) return null;
  return `${digits}@c.us`;
}

async function probeWahaStatus() {
  const env = getWahaEnvConfig();
  try {
    const base = assertInternalWahaUrl(env.baseUrl);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const headers = { Accept: 'application/json' };
      if (env.apiKey) headers['X-Api-Key'] = env.apiKey;
      const res = await fetch(`${base.origin}${base.pathname.replace(/\/+$/, '')}/api/sessions?all=true`, {
        method: 'GET',
        headers,
        signal: ctrl.signal
      });
      if (!res.ok) {
        return {
          reachable: false,
          http_status: res.status,
          session_name: env.session,
          session_status: 'UNAVAILABLE',
          has_api_key: Boolean(env.apiKey),
          env_forces_dry_run: env.envForcesDryRun
        };
      }
      const sessions = await res.json();
      const list = Array.isArray(sessions) ? sessions : [];
      const matched = list.find((s) => s && s.name === env.session) || list[0] || null;
      return {
        reachable: true,
        http_status: 200,
        session_name: matched?.name || env.session,
        session_status: matched?.status || 'STOPPED',
        engine: matched?.config?.engine || matched?.engine?.engine || 'NOWEB',
        has_api_key: Boolean(env.apiKey),
        env_forces_dry_run: env.envForcesDryRun
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return {
      reachable: false,
      http_status: null,
      session_name: env.session,
      session_status: 'OFFLINE_FALLBACK_WA_ME',
      error_hint: err.name === 'AbortError' ? 'timeout_3s' : (err.code || 'network_unreachable'),
      has_api_key: Boolean(env.apiKey),
      env_forces_dry_run: env.envForcesDryRun
    };
  }
}

/**
 * إرسال نص عبر WAHA أو محاكاة آمنة في وضع Dry-Run.
 * في Dry-Run: لا يخرج أي بايت إلى الشبكة، ويُعاد مظروف توصيفي **بدون نص الرسالة ولا رقم المرشح الكامل**
 * (رقم مقنّع فقط) حتى لا تتسرب بيانات المرشح إلى tabel السجل أو السجلات التشغيلية.
 */
/**
 * موافقة المالك الحيّة: تُقرأ من البيئة **في لحظة الإرسال نفسها** (بدون أي تخزين مؤقت).
 * لا يوجد أي مسار حيّ بدونها، حتى لو كانت كل الإعدادات الأخرى تسمح بذلك.
 */
function isOwnerLiveApproved() {
  return String(process.env.WAHA_LIVE_APPROVED || '').toLowerCase() === 'true';
}

async function sendOrSimulateWahaText({ recipientPhone, text, idempotencyKey, effectiveDryRun, templateKey, liveApprovalToken }) {
  const env = getWahaEnvConfig();
  const chatId = toWahaChatId(recipientPhone);
  if (!chatId) {
    throw Object.assign(new Error('رقم الجوال غير صالح لتنسيق واتساب الدولي.'), { code: 'INVALID_WA_PHONE' });
  }

  // حساب مهلة عشوائية مقترحة (8–18 ثانية) لتوثيق الانضباط التشغيلي ضد الحظر
  const suggestedJitterMs = 8000 + crypto.randomInt(0, 10001);

  // مظروف آمن للتسجيل: لا نص رسالة، لا رقم كامل، لا سر
  const auditEnvelope = {
    session: env.session,
    chat_id_masked: `${maskPhone(recipientPhone)}@c.us`,
    template_key: templateKey || null,
    idempotency_key: idempotencyKey || null,
    text_length: String(text || '').length,
    anti_ban_jitter_ms: suggestedJitterMs
  };

  // حارس الأمان الثلاثي عند حد الإرسال الفعلي نفسه:
  //  1) قفل البيئة WAHA_DRY_RUN (افتراضي true)
  //  2) قفل قاعدة البيانات (dry_run / kill_switch / enabled) المُمرَّر من طبقة المسارات تحت القفل الاستشاري
  //  3) موافقة المالك WAHA_LIVE_APPROVED مقروءة الآن + رمز موافقة صريح من طبقة المسارات
  // أي إخلال بأحدها يُسقط المحاولة إلى محاكاة جافة (صفر بايت) ولا يرمي خطأ تشغيلياً.
  const approvalOkNow = isOwnerLiveApproved() && liveApprovalToken === 'OWNER_APPROVED_LIVE';
  if (env.envForcesDryRun || effectiveDryRun || !approvalOkNow) {
    return {
      mode: 'dry_run',
      sent_live: false,
      external_message_id: `dryrun-${crypto.randomBytes(6).toString('hex')}`,
      envelope: {
        ...auditEnvelope,
        simulated_at: new Date().toISOString(),
        zero_network_send: true,
        dry_run_reason: env.envForcesDryRun
          ? 'ENV_WAHA_DRY_RUN_TRUE'
          : effectiveDryRun
            ? 'DB_GOVERNANCE_BLOCK'
            : 'OWNER_APPROVAL_MISSING'
      }
    };
  }

  // المسار الحي: لا يُنفّذ إلا بعد اجتياز حارس العنوان الداخلي أعلاه
  const base = assertInternalWahaUrl(env.baseUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    if (env.apiKey) headers['X-Api-Key'] = env.apiKey;

    const res = await fetch(`${base.origin}${base.pathname.replace(/\/+$/, '')}/api/sendText`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        session: env.session,
        chatId,
        text: String(text || '')
      }),
      signal: ctrl.signal
    });

    if (!res.ok) {
      const errTxt = await res.text().catch(() => '');
      // رسالة الخطأ تُقصّ وتُنقّى من أي مفتاح API قد يعيده الوسيط بالخطأ
      const safeDetail = String(errTxt || '')
        .replace(env.apiKey || '\u0000', '[redacted]')
        .slice(0, 160);
      throw Object.assign(new Error(`WAHA HTTP ${res.status}: ${safeDetail}`), {
        code: 'WAHA_UPSTREAM_ERROR',
        upstreamStatus: res.status
      });
    }

    const data = await res.json().catch(() => ({}));
    return {
      mode: 'live',
      sent_live: true,
      external_message_id: String(data.id || data.key?.id || `waha-${Date.now()}`),
      envelope: auditEnvelope
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  isOwnerLiveApproved,
  maskPhone,
  getWahaEnvConfig,
  assertInternalWahaUrl,
  normalizePhoneDigits,
  toWahaChatId,
  probeWahaStatus,
  sendOrSimulateWahaText
};
