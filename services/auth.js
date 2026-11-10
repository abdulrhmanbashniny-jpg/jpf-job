const crypto = require('crypto');

const COOKIE_NAME = 'jpf_hr_session';
const CANDIDATE_COOKIE_NAME = 'jpf_cand_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 ساعة للجنة
const CANDIDATE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 يوماً للمتقدم على متصفحه
const VISIT_PASS_TTL_MS = 45 * 24 * 60 * 60 * 1000; // 45 يوماً لبطاقة الزيارة وتأكيد الحضور

function getSessionSecret() {
  return (
    process.env.SESSION_SECRET ||
    crypto
      .createHash('sha256')
      .update(`jpf-hr-secret::${process.env.ADMIN_ACCESS_CODE || 'RUWAA-HR-2026'}::${process.env.DATABASE_URL || 'local'}`)
      .digest('hex')
  );
}

function getPurposeKey(purpose) {
  return crypto
    .createHmac('sha256', getSessionSecret())
    .update(`purpose-key::${purpose}`)
    .digest();
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
 * إنشاء توكن جلسة موظف/لجنة موقّع بـ HMAC-SHA256 (يُحفظ في كوكي HttpOnly فقط)
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
  const sig = crypto.createHmac('sha256', getPurposeKey('staff_session')).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;

  // دعم التوافق مع جلسات الموظفين الحالية + المفتاح المقيّد بالغرض
  const expectedScoped = crypto.createHmac('sha256', getPurposeKey('staff_session')).update(payloadB64).digest('base64url');
  const expectedLegacy = crypto.createHmac('sha256', getSessionSecret()).update(payloadB64).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const okScoped = sigBuf.length === Buffer.byteLength(expectedScoped) && crypto.timingSafeEqual(sigBuf, Buffer.from(expectedScoped));
  const okLegacy = !okScoped && sigBuf.length === Buffer.byteLength(expectedLegacy) && crypto.timingSafeEqual(sigBuf, Buffer.from(expectedLegacy));
  if (!okScoped && !okLegacy) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp || !payload.uid || !payload.role) return null;
    return payload;
  } catch (_e) {
    return null;
  }
}

/**
 * إنشاء رمز غير قابل للتخمين ومقيّد بالغرض (Purpose-Scoped Token)
 * الأغراض المدعومة:
 * - 'visit_pass': لبطاقة الزيارة وتأكيد الحضور فقط (مربوط بـ interview.id + interview.visit_token)
 * - 'candidate_portal': لمتابعة المتقدم لاختباره ونتيجته فقط (مربوط بـ reference_no + candidate_access_token)
 */
function createScopedToken(purpose, subjectId, dbSecretNonce, ttlMs = VISIT_PASS_TTL_MS) {
  if (!purpose || !subjectId || !dbSecretNonce) {
    throw new Error('معطيات الرمز المقيّد بالغرض غير مكتملة.');
  }
  const payload = {
    p: String(purpose),
    sub: String(subjectId),
    n: String(dbSecretNonce).slice(0, 32),
    exp: Date.now() + ttlMs
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getPurposeKey(purpose)).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifyScopedToken(token, expectedPurpose) {
  if (!token || typeof token !== 'string' || !token.includes('.') || !expectedPurpose) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return null;

  const expectedSig = crypto.createHmac('sha256', getPurposeKey(expectedPurpose)).update(payloadB64).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.p !== expectedPurpose) return null;
    if (!payload.exp || Date.now() > payload.exp) return null;
    if (!payload.sub || !payload.n) return null;
    return payload;
  } catch (_e) {
    return null;
  }
}

function createVisitPassToken(interviewId, visitNonce) {
  return createScopedToken('visit_pass', interviewId, visitNonce, VISIT_PASS_TTL_MS);
}

function verifyVisitPassToken(token) {
  return verifyScopedToken(token, 'visit_pass');
}

function createCandidatePortalToken(referenceNo, candidateAccessNonce) {
  return createScopedToken('candidate_portal', String(referenceNo).toUpperCase(), candidateAccessNonce, CANDIDATE_TTL_MS);
}

function verifyCandidatePortalToken(token, expectedRefNo, dbCandidateAccessNonce) {
  const parsed = verifyScopedToken(token, 'candidate_portal');
  if (!parsed) return false;
  if (String(parsed.sub).toUpperCase() !== String(expectedRefNo).toUpperCase()) return false;
  const expectedNonceSlice = String(dbCandidateAccessNonce || '').slice(0, 32);
  if (!expectedNonceSlice) return false;
  const a = Buffer.from(String(parsed.n));
  const b = Buffer.from(expectedNonceSlice);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
    try {
      out[k] = decodeURIComponent(v);
    } catch (_e) {
      out[k] = v;
    }
  }
  return out;
}

function getSessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  return verifySessionToken(token);
}

function setSessionCookie(res, token, req) {
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const flags = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (isSecure) flags.push('Secure');
  res.append('Set-Cookie', flags.join('; '));
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * حفظ رمز المتقدم المقيّد بالغرض داخل كوكي HttpOnly (يدعم حتى 5 طلبات لنفس المتصفح)
 */
function setCandidateCookie(res, req, referenceNo, candidatePortalToken) {
  const cookies = parseCookies(req.headers.cookie);
  let map = {};
  if (cookies[CANDIDATE_COOKIE_NAME]) {
    try {
      const parsed = JSON.parse(Buffer.from(cookies[CANDIDATE_COOKIE_NAME], 'base64url').toString('utf8'));
      if (parsed && typeof parsed === 'object') map = parsed;
    } catch (_e) {}
  }
  const key = String(referenceNo).toUpperCase();
  map[key] = candidatePortalToken;
  const entries = Object.entries(map).slice(-5);
  const encoded = Buffer.from(JSON.stringify(Object.fromEntries(entries)), 'utf8').toString('base64url');

  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const flags = [
    `${CANDIDATE_COOKIE_NAME}=${encoded}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(CANDIDATE_TTL_MS / 1000)}`
  ];
  if (isSecure) flags.push('Secure');
  res.append('Set-Cookie', flags.join('; '));
}

function extractCandidateTokenFromRequest(req, referenceNo) {
  const direct = req.query?.ct || req.headers['x-candidate-token'] || req.body?.candidate_token;
  if (direct && typeof direct === 'string') return direct.trim();

  const cookies = parseCookies(req.headers.cookie);
  const rawCookie = cookies[CANDIDATE_COOKIE_NAME];
  if (!rawCookie) return null;
  try {
    const map = JSON.parse(Buffer.from(rawCookie, 'base64url').toString('utf8'));
    if (referenceNo && map[String(referenceNo).toUpperCase()]) {
      return map[String(referenceNo).toUpperCase()];
    }
    // في حال عدم تمرير رقم الطلب (مثل رفع مرفق سؤال أثناء الاختبار)، إرجاع أحدث رمز صالح
    const vals = Object.values(map);
    return vals.length ? vals[vals.length - 1] : null;
  } catch (_e) {
    return null;
  }
}

const ROLE_LABELS = {
  super_admin: 'مدير النظام / رئيس اللجنة',
  committee_member: 'عضو لجنة التوظيف',
  hr_coordinator: 'منسق الموارد البشرية والمقابلات'
};

/**
 * Middleware لحماية نقاط النهاية حسب الدور الوظيفي (RBAC)
 */
function requireAuth(allowedRoles = null) {
  return (req, res, next) => {
    const session = getSessionFromRequest(req);
    if (!session) {
      return res.status(401).json({
        error: 'يلزم تسجيل الدخول بحساب معتمد للوصول إلى لوحة اللجنة.',
        code: 'AUTH_REQUIRED'
      });
    }
    if (Array.isArray(allowedRoles) && allowedRoles.length > 0 && !allowedRoles.includes(session.role)) {
      return res.status(403).json({
        error: 'ليست لديك الصلاحية الكافية لتنفيذ هذا الإجراء.',
        code: 'FORBIDDEN_ROLE'
      });
    }
    req.user = session;
    next();
  };
}

module.exports = {
  COOKIE_NAME,
  CANDIDATE_COOKIE_NAME,
  ROLE_LABELS,
  hashPassword,
  verifyPassword,
  createSessionToken,
  getSessionFromRequest,
  setSessionCookie,
  clearSessionCookie,
  createVisitPassToken,
  verifyVisitPassToken,
  createCandidatePortalToken,
  verifyCandidatePortalToken,
  setCandidateCookie,
  extractCandidateTokenFromRequest,
  verifyScopedToken,
  requireAuth
};
