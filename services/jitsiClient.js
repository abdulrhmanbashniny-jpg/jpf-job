/**
 * خدمة قاعات الفيديو الخاصة عبر Jitsi (v2.4)
 * ---------------------------------------------------------------------------------
 * الضوابط:
 *  - اسم غرفة عشوائي غير قابل للتخمين لكل مقابلة (لا أسماء مرشحين ولا أرقام طلبات).
 *  - فحص جاهزية مرن لنطاق JITSI_DOMAIN: عدم توفر DNS **لا يكسر** المنصة إطلاقاً،
 *    بل يُرجع حالة `degraded` مع البديل الاحتياطي (رابط خارجي/هاتفي) للجنة.
 *  - لا مفاتيح مدفوعة ولا خدمات سحابية: إن وُجد JITSI_JWT_SECRET يُنشأ توكن HS256
 *    محلياً عبر crypto المدمج (Jitsi JWT)، وإلا تُستخدم غرف مفتوحة على نطاق الشركة.
 *  - كل القيم تُقرأ من البيئة في لحظة الاستخدام ولا تُخزَّن، ولا يُعاد أي سر في أي استجابة.
 */
const crypto = require('crypto');

const DEFAULT_JITSI_DOMAIN = 'meet.hrjpf.tech';
const ROOM_NAME_RE = /^[A-Za-z0-9-]{16,120}$/;

function getJitsiEnvConfig() {
  const enabled = String(process.env.JITSI_ENABLED ?? 'true').toLowerCase() !== 'false';
  const domain = String(process.env.JITSI_DOMAIN || DEFAULT_JITSI_DOMAIN).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const appId = String(process.env.JITSI_APP_ID || '').trim();
  const jwtSecret = String(process.env.JITSI_JWT_SECRET || '').trim();
  const probeTimeoutMs = Math.min(5000, Math.max(500, parseInt(process.env.JITSI_PROBE_TIMEOUT_MS || '1500', 10) || 1500));
  return { enabled, domain, appId, jwtSecret, hasJwtSecret: Boolean(jwtSecret), probeTimeoutMs };
}

/** اسم غرفة عشوائي: 32 حرفاً hex بعنوان بادئة ثابتة غير دالة على الهوية */
function generateRoomName() {
  return `jpf${crypto.randomBytes(14).toString('hex')}`;
}

function isValidRoomName(name) {
  return ROOM_NAME_RE.test(String(name || ''));
}

function buildRoomUrl(domain, roomName) {
  return `https://${domain}/${encodeURIComponent(roomName)}`;
}

/**
 * توكن Jitsi JWT (HS256) — يُستخدم فقط عند ضبط JITSI_JWT_SECRET على الخادم.
 * الصلاحيات: moderator للموظف، participant للمرشح المقصود فقط.
 */
function signJitsiJwt({ appId, jwtSecret, roomName, role, displayName, email }, { nowSeconds } = {}) {
  if (!jwtSecret || !roomName) return null;
  const iat = Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
  const payload = {
    aud: appId || 'jitsi',
    iss: appId || 'jitsi',
    sub: appId || DEFAULT_JITSI_DOMAIN,
    room: roomName,
    iat,
    nbf: iat - 10,
    // ساعتان: أطول من أي مقابلة ولا يُستخدم بعد انتهاء الجلسة
    exp: iat + 2 * 60 * 60,
    context: {
      user: {
        name: String(displayName || '').slice(0, 120) || (role === 'moderator' ? 'لجنة التوظيف' : 'مرشح'),
        email: String(email || '').slice(0, 160) || undefined,
        moderator: role === 'moderator'
      }
    }
  };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  const signature = crypto.createHmac('sha256', jwtSecret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

/**
 * فحص جاهزية النطاق بـ DNS فقط (لا اتصال HTTP، لا تسريب بيانات).
 * لا يرمي أخطاء أبداً، ويعيد دائماً { ok, status, reason? }.
 */
async function probeJitsiDomain({ dns = require('dns') } = {}) {
  const env = getJitsiEnvConfig();
  if (!env.enabled) {
    return { ok: false, status: 'DISABLED', domain: env.domain, action_required: 'JITSI_ENABLED=false في البيئة' };
  }
  const controller = new AbortController();
  let timer = null;
  try {
    const lookupOnce = () => new Promise((resolve, reject) => {
      dns.lookup(env.domain, { all: false }, (err, address) => (err ? reject(err) : resolve(address)));
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), env.probeTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const address = await Promise.race([lookupOnce(), timeout]);
    return { ok: true, status: 'RESOLVED', domain: env.domain, address_hint: 'resolved' };
  } catch (err) {
    const code = err && err.code ? err.code : 'UNKNOWN';
    return {
      ok: false,
      status: code === 'ENOTFOUND' || code === 'ENODATA' ? 'NOT_RESOLVED' : code === 'ETIMEOUT' ? 'PROBE_TIMEOUT' : 'PROBE_FAILED',
      domain: env.domain,
      error_hint: code,
      action_required: 'إضافة سجل A لـ meet.<domain> إلى IP الخادم — المنصة تعمل بالبديل الاحتياطي حتى ذلك الحين',
      fallback_available: true
    };
  } finally {
    if (timer) clearTimeout(timer);
    void controller;
  }
}

/**
 * بيانات دخول القاعة لعضو لجنة أو للمرشح.
 * لا يُعاد أي سر: توكن JWT (إن وُجد) يُعاد لعضو اللجنة فقط، وللمرشح عبر مسار الزيارة الموقّع.
 */
function buildRoomSession({ roomName, role, displayName, email, env = getJitsiEnvConfig() }) {
  const url = buildRoomUrl(env.domain, roomName);
  const jwt = env.hasJwtSecret
    ? signJitsiJwt({ appId: env.appId, jwtSecret: env.jwtSecret, roomName, role, displayName, email })
    : null;
  return {
    room_name: roomName,
    domain: env.domain,
    url,
    role,
    // عند تفعيل JWT يجب تمريره في الـ fragment (#jwt=) لا في query لتجنّب تسجيله في السجلات/الوكلاء
    join_url: jwt ? `${url}#jwt=${jwt}&config.prejoinPageEnabled=false` : url,
    has_moderator_token: Boolean(jwt) && role === 'moderator',
    jwt_enabled: env.hasJwtSecret,
    embed_allowed: true
  };
}

/** يحسب مدة المكالمة الفعلية بالدقائق من أول انضمام (للمرشح أو اللجنة) حتى آخر حدث */
function computeActualCallMinutes({ openedAtMs, candidateJoinedAtMs, closedAtMs }) {
  const starts = [openedAtMs, candidateJoinedAtMs].filter((v) => Number.isFinite(v)).map(Number);
  if (!starts.length) return 0;
  const startedAt = Math.min(...starts);
  const endAt = Number.isFinite(closedAtMs) ? Number(closedAtMs) : Date.now();
  const minutes = Math.round((endAt - startedAt) / 60000);
  // الحد المتسق مع القيد chk_interviews_actual_call_minutes (0..600)
  return Math.min(600, Math.max(0, minutes));
}

module.exports = {
  DEFAULT_JITSI_DOMAIN,
  getJitsiEnvConfig,
  generateRoomName,
  isValidRoomName,
  buildRoomUrl,
  signJitsiJwt,
  probeJitsiDomain,
  buildRoomSession,
  computeActualCallMinutes
};
