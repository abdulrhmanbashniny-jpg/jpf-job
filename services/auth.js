const crypto = require('crypto');

const COOKIE_NAME = 'jpf_hr_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 ساعة

function getSessionSecret() {
  return (
    process.env.SESSION_SECRET ||
    crypto
      .createHash('sha256')
      .update(`jpf-hr-secret::${process.env.ADMIN_ACCESS_CODE || 'RUWAA-HR-2026'}::${process.env.DATABASE_URL || 'local'}`)
      .digest('hex')
  );
}

/**
 * تشفير كلمة المرور بخوارزمية PBKDF2-SHA512 مع Salt عشوائي
 */
function hashPassword(plainPassword) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.pbkdf2Sync(String(plainPassword), salt, 120000, 64, 'sha512').toString('hex');
  return `pbkdf2_sha512$120000$${salt}$${derived}`;
}

/**
 * التحقق الآمن من كلمة المرور ضد الهجمات الزمنية (Timing-Safe)
 */
function verifyPassword(plainPassword, storedHash) {
  try {
    const parts = String(storedHash || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha512') return false;
    const iterations = parseInt(parts[1], 10);
    const salt = parts[2];
    const expectedHex = parts[3];
    const actualBuf = crypto.pbkdf2Sync(String(plainPassword), salt, iterations, 64, 'sha512');
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    if (actualBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(actualBuf, expectedBuf);
  } catch (_e) {
    return false;
  }
}

/**
 * إنشاء توكن جلسة موقّع بـ HMAC-SHA256 (يُحفظ في كوكي HttpOnly فقط)
 */
function createSessionToken(user) {
  const payload = {
    uid: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    job_title: user.job_title || '',
    exp: Date.now() + SESSION_TTL_MS
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', getSessionSecret()).update(payloadB64).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (_e) {
    return null;
  }
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  const pairs = String(cookieHeader).split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function getSessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

function setSessionCookie(res, token, req) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`
  ];
  if (isHttps) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

const ROLE_LABELS = {
  super_admin: 'مدير النظام ورئيس اللجنة',
  committee_member: 'عضو لجنة التوظيف',
  hr_coordinator: 'منسق الموارد البشرية والمقابلات'
};

/**
 * وسيط التحقق من تسجيل الدخول لمسارات الـ API الخاصة باللجنة
 */
function requireAuth(allowedRoles = null) {
  return (req, res, next) => {
    const session = getSessionFromRequest(req);
    if (!session) {
      return res.status(401).json({ error: 'يلزم تسجيل الدخول بحساب لجنة التوظيف للوصول إلى هذا المورد.', auth_required: true });
    }
    if (Array.isArray(allowedRoles) && allowedRoles.length > 0 && !allowedRoles.includes(session.role)) {
      return res.status(403).json({
        error: `صلاحيات حسابك الحالية (${ROLE_LABELS[session.role] || session.role}) لا تسمح بتنفيذ هذا الإجراء.`
      });
    }
    req.user = session;
    next();
  };
}

module.exports = {
  COOKIE_NAME,
  ROLE_LABELS,
  hashPassword,
  verifyPassword,
  createSessionToken,
  getSessionFromRequest,
  setSessionCookie,
  clearSessionCookie,
  requireAuth
};
