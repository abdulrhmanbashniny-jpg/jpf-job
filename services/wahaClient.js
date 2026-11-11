/**
 * عميل حوكمة واتساب التشغيلي عبر WAHA (v2.3)
 * يطبق بشكل صارم:
 *  - قفل WAHA_DRY_RUN=true افتراضياً (صفر رسائل فعلية لأي مرشح ما لم يُرفع القفل من البيئة والإعدادات معاً).
 *  - فحص الجاهزية للقراءة فقط (GET /api/sessions) بمهلة 3 ثوانٍ دون أي اتصال خارجي قسري.
 *  - صيغة chatId القياسية لـ WAHA CORE/NOWEB: "<digits>@c.us" مع مهلة إرسال 5 ثوانٍ وسقوط آمن إلى wa.me.
 */
const crypto = require('crypto');

function getWahaEnvConfig() {
  const baseUrl = String(process.env.WAHA_BASE_URL || 'http://waha-bbg7-waha-1:3000').replace(/\/+$/, '');
  const apiKey = String(process.env.WAHA_API_KEY || '').trim();
  const session = String(process.env.WAHA_SESSION || 'default').trim();
  // القفل البيئي الصارم: يبقى true دائماً ما لم يُضبط WAHA_DRY_RUN=false صراحةً في البيئة
  const envForcesDryRun = String(process.env.WAHA_DRY_RUN ?? 'true').trim().toLowerCase() !== 'false';
  return { baseUrl, apiKey, session, envForcesDryRun };
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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const headers = { Accept: 'application/json' };
    if (env.apiKey) headers['X-Api-Key'] = env.apiKey;
    const res = await fetch(`${env.baseUrl}/api/sessions?all=true`, {
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
  } catch (err) {
    return {
      reachable: false,
      http_status: null,
      session_name: env.session,
      session_status: 'OFFLINE_FALLBACK_WA_ME',
      error_hint: err.name === 'AbortError' ? 'timeout_3s' : 'network_unreachable',
      has_api_key: Boolean(env.apiKey),
      env_forces_dry_run: env.envForcesDryRun
    };
  } finally {
    clearTimeout(timer);
  }
}

async function sendOrSimulateWahaText({ recipientPhone, text, idempotencyKey, effectiveDryRun }) {
  const env = getWahaEnvConfig();
  const chatId = toWahaChatId(recipientPhone);
  if (!chatId) {
    throw Object.assign(new Error('رقم الجوال غير صالح لتنسيق واتساب الدولي.'), { code: 'INVALID_WA_PHONE' });
  }

  // حساب مهلة عشوائية مقترحة (8–18 ثانية) لتوثيق الانضباط التشغيلي ضد الحظر
  const suggestedJitterMs = 8000 + crypto.randomInt(0, 10001);

  const outboundEnvelope = {
    session: env.session,
    chatId,
    text: String(text || ''),
    idempotency_key: idempotencyKey,
    anti_ban_jitter_ms: suggestedJitterMs
  };

  // حارس الأمان المزدوج: إذا كان WAHA_DRY_RUN مفروضاً من البيئة أو من قاعدة البيانات، لا يخرج أي طلب إرسال فعلي إطلاقاً
  if (env.envForcesDryRun || effectiveDryRun) {
    return {
      mode: 'dry_run',
      sent_live: false,
      external_message_id: `dryrun-${crypto.randomBytes(6).toString('hex')}`,
      envelope: {
        ...outboundEnvelope,
        simulated_at: new Date().toISOString(),
        zero_network_send: true
      }
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    if (env.apiKey) headers['X-Api-Key'] = env.apiKey;

    const res = await fetch(`${env.baseUrl}/api/sendText`, {
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
      throw Object.assign(new Error(`WAHA HTTP ${res.status}: ${errTxt.slice(0, 160)}`), {
        code: 'WAHA_UPSTREAM_ERROR',
        upstreamStatus: res.status
      });
    }

    const data = await res.json().catch(() => ({}));
    return {
      mode: 'live',
      sent_live: true,
      external_message_id: String(data.id || data.key?.id || `waha-${Date.now()}`),
      envelope: outboundEnvelope
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  getWahaEnvConfig,
  toWahaChatId,
  probeWahaStatus,
  sendOrSimulateWahaText
};
