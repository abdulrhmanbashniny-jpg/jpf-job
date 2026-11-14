require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const QRCode = require('qrcode');
const { version: APP_VERSION } = require('./package.json');

const { pool, query, ensureDatabaseInitialized, logAudit } = require('./database/db');
const {
  evaluateSubmission,
  evaluateDeterministicInstant,
  enrichReportWithExternalAI,
  anonymizeText,
  getProvidersEnvStatus,
  listOllamaModels,
  testOllamaModel
} = require('./services/aiEvaluator');
const wahaClient = require('./services/wahaClient');
const { createWahaRoutes } = require('./services/wahaRoutes');
const jitsiClient = require('./services/jitsiClient');
const { createJitsiRoutes } = require('./services/jitsiRoutes');
const offerPdf = require('./services/offerPdf');
const outbox = require('./services/automationOutbox');
const { createOfferRoutes } = require('./services/offerRoutes');
const {
  ROLE_LABELS,
  hashPassword,
  verifyPassword,
  createSessionToken,
  getSessionFromRequest,
  setSessionCookie,
  clearSessionCookie,
  createVisitPassToken,
  verifyVisitPassToken,
  createReceptionQrToken,
  verifyReceptionQrToken,
  createCandidatePortalToken,
  verifyCandidatePortalToken,
  deriveCandidateAccessKey,
  verifyCandidateAccessKey,
  setCandidateCookie,
  extractCandidateTokenFromRequest,
  extractAllCandidateTokensFromRequest,
  verifyScopedToken,
  resolveActiveStaffSession,
  createRequireAuth
} = require('./services/auth');

const requireAuth = createRequireAuth(query);

function isValidTimeHHMM(val) {
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(val || '').trim());
}

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '10', 10);

const uploadsDir = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, 'uploads');
const publicUploadsDir = path.join(uploadsDir, 'public');
const voiceUploadsDir = path.join(uploadsDir, 'voice_pitches');
if (!fs.existsSync(publicUploadsDir)) {
  fs.mkdirSync(publicUploadsDir, { recursive: true });
}
if (!fs.existsSync(voiceUploadsDir)) {
  fs.mkdirSync(voiceUploadsDir, { recursive: true });
}

const MAX_VOICE_BYTES = Math.round(2.5 * 1024 * 1024);
const uploadVoiceMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VOICE_BYTES }
});

const voiceUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.VOICE_UPLOAD_MAX_PER_WINDOW || '5', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'تم تجاوز الحد الأقصى لمحاولات رفع المقاطع الصوتية؛ يرجى الانتظار 15 دقيقة قبل المحاولة مجدداً.',
    code: 'VOICE_UPLOAD_RATE_LIMITED'
  }
});

async function getVoicePitchFeatureConfig() {
  const envEnabled = String(process.env.VOICE_PITCH_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
  try {
    const { rows } = await query("SELECT setting_value FROM system_settings WHERE setting_key = 'voice_pitch_config'");
    const dbCfg = rows[0]?.setting_value || {};
    return {
      enabled: Boolean(envEnabled && dbCfg.enabled !== false),
      env_enabled: envEnabled,
      db_enabled: dbCfg.enabled !== false,
      max_uploads_per_application: Math.max(1, Math.min(10, parseInt(dbCfg.max_uploads_per_application, 10) || 3))
    };
  } catch (_e) {
    return { enabled: envEnabled, env_enabled: envEnabled, db_enabled: true, max_uploads_per_application: 3 };
  }
}

function isVoiceRowActive(appRow) {
  if (!appRow || !appRow.voice_pitch_path) return false;
  if (appRow.status === 'offered') return true;
  if (!appRow.voice_retention_expires_at) return true;
  return new Date(appRow.voice_retention_expires_at).getTime() > Date.now();
}

function unlinkVoiceFileStrict(diskPath) {
  if (!diskPath) return;
  try {
    fs.unlinkSync(diskPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
}

function detectSafeAudioContainer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  // WebM / Matroska EBML: 1A 45 DF A3
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { mime: 'audio/webm', ext: '.webm' };
  }
  // Ogg Opus/Vorbis: "OggS"
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
    return { mime: 'audio/ogg', ext: '.ogg' };
  }
  // MP4 / M4A: bytes 4..7 == "ftyp"
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    return { mime: 'audio/mp4', ext: '.m4a' };
  }
  // WAV: "RIFF" + bytes 8..11 == "WAVE"
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45
  ) {
    return { mime: 'audio/wav', ext: '.wav' };
  }
  // MP3: "ID3" header or valid MPEG Audio frame sync
  if (
    (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) ||
    (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && (buf[1] & 0x06) !== 0x00)
  ) {
    return { mime: 'audio/mpeg', ext: '.mp3' };
  }
  return null;
}

function resolveSafeVoiceDiskPath(storedRelName) {
  if (!storedRelName) return null;
  const baseName = path.basename(String(storedRelName));
  if (!baseName || baseName.includes('..')) return null;
  const full = path.resolve(voiceUploadsDir, baseName);
  if (!full.startsWith(voiceUploadsDir + path.sep)) return null;
  return full;
}

function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_e) {}
}

function hasCandidateOwnershipProof(req, targetApps, rawAccessKey) {
  const candidateTokens = extractAllCandidateTokensFromRequest(req);
  const cleanKey = String(rawAccessKey || '').trim();
  for (const appRow of targetApps) {
    if (!appRow || !appRow.reference_no || !appRow.candidate_access_token) continue;
    for (const tok of candidateTokens) {
      if (verifyCandidatePortalToken(tok, appRow.reference_no, appRow.candidate_access_token)) {
        return true;
      }
    }
    if (cleanKey && verifyCandidateAccessKey(cleanKey, appRow.reference_no, appRow.candidate_access_token)) {
      return true;
    }
  }
  return false;
}

app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 800,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'تم تجاوز الحد المسموح للطلبات، يرجى المحاولة بعد قليل.' }
});
app.use('/api/', apiLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات دخول متكررة، يرجى الانتظار 15 دقيقة قبل المحاولة مجدداً.' }
});

const candidateVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات تحقق كثيرة جداً، يرجى الانتظار 15 دقيقة قبل المحاولة مجدداً.' }
});

function buildVisitPassUrl(origin, interviewId, visitNonce) {
  const vt = createVisitPassToken(interviewId, visitNonce);
  return `${origin}/Visit.dc.html?vt=${encodeURIComponent(vt)}`;
}

function sanitizeReportForCandidate(report) {
  const r = report && typeof report === 'object' ? report : {};
  return {
    strengths: Array.isArray(r.strengths) ? r.strengths.slice(0, 5) : [],
    gaps: Array.isArray(r.gaps) ? r.gaps.slice(0, 5) : []
  };
}

const allowedExtensions = new Set(['.pdf', '.docx', '.doc', '.png', '.jpg', '.jpeg', '.webp']);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeTag = crypto.randomBytes(6).toString('hex');
    cb(null, `${Date.now()}-${safeTag}${ext}`);
  }
});

const publicImageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, publicUploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeTag = crypto.randomBytes(5).toString('hex');
    cb(null, `entrance-${Date.now()}-${safeTag}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!allowedExtensions.has(ext)) {
      return cb(new Error('صيغة الملف غير مدعومة. الصيغ المسموحة: PDF, DOCX, PNG, JPG, WEBP'));
    }
    cb(null, true);
  }
});

const uploadPublicImage = multer({
  storage: publicImageStorage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!new Set(['.png', '.jpg', '.jpeg', '.webp']).has(ext)) {
      return cb(new Error('يرجى رفع صورة بصيغة PNG أو JPG أو WEBP لمدخل المقر.'));
    }
    cb(null, true);
  }
});

// ---------------------------------------------------------------------------------
// بوابة الحماية الخلفية لصفحات اللجنة والمرفقات (مع السماح ببطاقة الزيارة Visit.dc.html)
// ---------------------------------------------------------------------------------
const PROTECTED_PAGE_ROLES = {
  '/Dashboard.dc.html': ['super_admin', 'hr_coordinator', 'committee_member'],
  '/JobBuilder.dc.html': ['super_admin', 'hr_coordinator'],
  '/CandidateProfile.dc.html': ['super_admin', 'hr_coordinator', 'committee_member'],
  '/Ranking.dc.html': ['super_admin', 'hr_coordinator', 'committee_member'],
  '/Scheduler.dc.html': ['super_admin', 'hr_coordinator', 'committee_member'],
  '/Interviews.dc.html': ['super_admin', 'hr_coordinator', 'committee_member'],
  '/Reception.dc.html': ['super_admin', 'hr_coordinator'],
  '/AIEngine.dc.html': ['super_admin', 'hr_coordinator', 'committee_member'],
  '/Settings.dc.html': ['super_admin'],
  '/System.dc.html': ['super_admin', 'hr_coordinator', 'committee_member'],
  '/Users.dc.html': ['super_admin']
};

app.use(async (req, res, next) => {
  const allowedRoles = PROTECTED_PAGE_ROLES[req.path];
  if (allowedRoles) {
    try {
      const session = await resolveActiveStaffSession(req, query);
      if (!session) {
        clearSessionCookie(res);
        const nextTarget = encodeURIComponent(req.originalUrl || req.path);
        return res.redirect(`/Login.dc.html?next=${nextTarget}`);
      }
      if (!allowedRoles.includes(session.role)) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(403).send('ليست لديك الصلاحية الكافية لفتح هذه الصفحة.');
      }
      res.setHeader('Cache-Control', 'no-store');
    } catch (err) {
      return next(err);
    }
  }
  next();
});

// السماح بعرض صورة مدخل المقر فقط للزوار في بطاقة الوصول الحضورية، مع إبقاء السير الذاتية محمية
app.use('/uploads/public', express.static(publicUploadsDir));

app.use('/uploads', async (req, res, next) => {
  try {
    if (req.path === '/voice_pitches' || req.path.startsWith('/voice_pitches/')) {
      return res.status(403).json({
        error: 'يُمنع الوصول المباشر للمقاطع الصوتية؛ يتم الاستماع حصراً عبر واجهة البث المسجّلة في سجل التدقيق.',
        code: 'DIRECT_VOICE_ACCESS_FORBIDDEN'
      });
    }
    // v2.5-R1: ملفات العروض الوظيفية تُسلَّم حصراً عبر /api/offers/:id/pdf
    // (مصادقة + سجل تدقيق) أو عبر توكن العرض للمرشح — لا عبر مسار ثابت.
    // هذا الحجب قبل التحقق من الجلسة عمداً: حتى المدير لا يصل مباشرة.
    // نطبّع المسار قبل الفحص: req.path لا يفكّ ترميز %6Fffers ⇒ تجاوز الفحص.
    let decodedPath = req.path;
    try { decodedPath = decodeURIComponent(req.path); } catch (_e) { /* مسار غير صالح */ }
    decodedPath = decodedPath.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (/^\/+(?:offers?)(\/|$)/i.test(decodedPath)) {
      return res.status(403).json({
        error: 'يُمنع الوصول المباشر لملفات العروض الوظيفية؛ التنزيل عبر المسارات المصرّح بها فقط.',
        code: 'DIRECT_OFFER_ACCESS_FORBIDDEN'
      });
    }
    const session = await resolveActiveStaffSession(req, query);
    if (!session) {
      clearSessionCookie(res);
      return res.status(401).send('غير مصرح بالوصول إلى ملفات السير الذاتية إلا لأعضاء لجنة التوظيف النشطين.');
    }
    next();
  } catch (err) {
    next(err);
  }
}, express.static(uploadsDir));

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------------
// دوال مساعدة وقوالب الرسائل الذكية (تدعم المتغيرات العربية والإنجليزية معاً)
// ---------------------------------------------------------------------------------
function normalizePhoneForWa(rawPhone) {
  let digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('05') && digits.length === 10) {
    digits = '966' + digits.slice(1);
  } else if (digits.startsWith('5') && digits.length === 9) {
    digits = '966' + digits;
  }
  return digits;
}

function buildWaLink(phone, messageBody) {
  const cleanPhone = normalizePhoneForWa(phone);
  return `https://wa.me/${cleanPhone}?text=${encodeURIComponent(messageBody)}`;
}

function getBaseOrigin(req) {
  if (process.env.PUBLIC_BASE_URL) return String(process.env.PUBLIC_BASE_URL).replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host') || 'hrjpf.tech';
  return `${proto}://${host}`;
}

function renderWhatsAppTemplate(tpl, ctx = {}) {
  const appointmentStr = ctx.date && ctx.time ? `${ctx.date} · ${ctx.time}` : (ctx.date || ctx.time || '');
  return String(tpl || '')
    .replace(/\{\{name\}\}|\{الاسم\}/g, ctx.name || '')
    .replace(/\{\{job_title\}\}|\{الوظيفة\}/g, ctx.job_title || '')
    .replace(/\{\{job_code\}\}|\{كود_الوظيفة\}/g, ctx.job_code || '')
    .replace(/\{\{ref\}\}|\{رقم_الطلب\}/g, ctx.reference_no || '')
    .replace(/\{\{date\}\}|\{التاريخ\}/g, ctx.date || '')
    .replace(/\{\{time\}\}|\{الوقت\}/g, ctx.time || '')
    .replace(/\{موعد_المقابلة\}/g, appointmentStr)
    .replace(/\{\{meet_url\}\}|\{رابط_القاعة\}/g, ctx.meet_url || ctx.visit_url || '')
    .replace(/\{\{visit_url\}\}|\{رابط_الحجز\}|\{بطاقة_الموقع\}/g, ctx.visit_url || '')
    .replace(/\{\{building\}\}|\{المقر\}/g, ctx.building || '')
    .replace(/\{\{floor\}\}|\{الدور\}/g, ctx.floor || '')
    .replace(/\{\{office\}\}|\{المكتب\}/g, ctx.office || '')
    .replace(/\{\{maps_url\}\}|\{رابط_الخريطة\}/g, ctx.maps_url || '');
}

function sanitizeQuestionsForCandidate(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.map((q) => ({
    index: q.index,
    type: q.type,
    points: q.points || 10,
    question: q.question,
    options: q.options || undefined,
    unit: q.unit || undefined,
    min_words: q.min_words || undefined
  }));
}

function extractReadableTextFromUpload(filePath, originalName) {
  try {
    const buf = fs.readFileSync(filePath);
    const asciiMatches = buf.toString('utf8').match(/[\u0600-\u06FFa-zA-Z0-9@._\-\s]{6,}/g) || [];
    const snippet = asciiMatches.join(' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
    return snippet || `ملف سيرة ذاتية مرفوع: ${originalName}`;
  } catch (_e) {
    return `ملف سيرة ذاتية مرفوع: ${originalName}`;
  }
}

function timeToMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map((x) => parseInt(x, 10) || 0);
  return h * 60 + m;
}

function minutesToTime(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

async function getCompanyLocationConfig() {
  const res = await query("SELECT setting_value FROM system_settings WHERE setting_key = 'company_location'");
  return res.rows[0]?.setting_value || {
    hr_whatsapp_phone: '966550000000',
    building_name: 'المقر الرئيسي — شركة رُواء للدهانات والحلول الهندسية',
    address_line: 'طريق الملك عبدالعزيز، جدة',
    floor_number: 'الدور الثالث (3)',
    office_number: 'مكتب 304 — قاعة الاجتماعات',
    google_maps_url: 'https://maps.google.com/?q=21.5800,39.1300',
    entrance_image_url: '/img/hq-entrance.svg',
    arrival_instructions: 'يرجى الحضور قبل الموعد بـ 10 دقائق وإبراز بطاقة المقابلة للاستقبال.'
  };
}

// ---------------------------------------------------------------------------------
// 0. مسارات المصادقة وإدارة الصلاحيات (Authentication & RBAC Users)
// ---------------------------------------------------------------------------------

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'يرجى إدخال اسم المستخدم وكلمة المرور.' });
    }

    const { rows } = await query(
      'SELECT * FROM staff_users WHERE LOWER(username) = LOWER($1) LIMIT 1',
      [String(username).trim()]
    );

    if (!rows.length || !verifyPassword(password, rows[0].password_hash)) {
      await logAudit({
        actor: String(username).trim(),
        actorRole: 'anonymous',
        action: 'AUTH_LOGIN_FAILED',
        entityType: 'staff_users',
        entityId: String(username).trim(),
        ipAddress: req.ip
      });
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });
    }

    const user = rows[0];
    if (!user.is_active) {
      return res.status(403).json({ error: 'هذا الحساب موقوف حالياً، يرجى مراجعة مدير النظام.' });
    }

    await query('UPDATE staff_users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    const token = createSessionToken(user);
    setSessionCookie(res, token, req);

    await logAudit({
      actor: user.full_name,
      actorRole: user.role,
      action: 'AUTH_LOGIN_SUCCESS',
      entityType: 'staff_users',
      entityId: user.username,
      metadata: { role: user.role },
      ipAddress: req.ip
    });

    res.json({
      message: `مرحباً بك ${user.full_name}`,
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        job_title: user.job_title,
        role: user.role,
        role_label: ROLE_LABELS[user.role] || user.role
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ message: 'تم تسجيل الخروج بنجاح.' });
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const session = await resolveActiveStaffSession(req, query);
    if (!session) {
      clearSessionCookie(res);
      return res.status(401).json({ authenticated: false });
    }
    res.json({
      authenticated: true,
      user: {
        id: session.uid,
        username: session.username,
        full_name: session.full_name,
        job_title: session.job_title,
        role: session.role,
        role_label: ROLE_LABELS[session.role] || session.role
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/change-password', requireAuth(), async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password || String(new_password).length < 8) {
      return res.status(400).json({ error: 'كلمة المرور الجديدة يجب ألا تقل عن 8 خانات.' });
    }

    const { rows } = await query('SELECT * FROM staff_users WHERE id = $1', [req.user.uid]);
    if (!rows.length || !verifyPassword(current_password, rows[0].password_hash)) {
      return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة.' });
    }

    const newHash = hashPassword(new_password);
    await query('UPDATE staff_users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, req.user.uid]);

    await logAudit({
      actor: req.user.full_name,
      actorRole: req.user.role,
      action: 'PASSWORD_CHANGED',
      entityType: 'staff_users',
      entityId: req.user.username,
      ipAddress: req.ip
    });

    res.json({ message: 'تم تحديث كلمة المرور بنجاح.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users', requireAuth(['super_admin']), async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, username, full_name, job_title, role, is_active, last_login_at, created_at
       FROM staff_users
       ORDER BY id ASC`
    );
    res.json({
      users: rows.map((u) => ({ ...u, role_label: ROLE_LABELS[u.role] || u.role }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', requireAuth(['super_admin']), async (req, res) => {
  try {
    const { username, full_name, job_title, role = 'committee_member', password } = req.body || {};
    if (!username || !full_name || !password || String(password).length < 8) {
      return res.status(400).json({ error: 'يرجى إدخال اسم المستخدم والاسم الكامل وكلمة مرور لا تقل عن 8 خانات.' });
    }
    if (!['super_admin', 'committee_member', 'hr_coordinator'].includes(role)) {
      return res.status(400).json({ error: 'نوع الصلاحية غير صالح.' });
    }

    const cleanUser = String(username).trim().toLowerCase();
    const pwdHash = hashPassword(password);

    const { rows } = await query(
      `INSERT INTO staff_users (username, full_name, job_title, role, password_hash, is_active)
       VALUES ($1,$2,$3,$4,$5,TRUE)
       RETURNING id, username, full_name, job_title, role, is_active, created_at`,
      [cleanUser, String(full_name).trim(), job_title || ROLE_LABELS[role], role, pwdHash]
    );

    await logAudit({
      actor: req.user.full_name,
      actorRole: req.user.role,
      action: 'STAFF_USER_CREATED',
      entityType: 'staff_users',
      entityId: cleanUser,
      metadata: { role, full_name },
      ipAddress: req.ip
    });

    res.status(201).json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'اسم المستخدم مسجل مسبقاً.' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/users/:id', requireAuth(['super_admin']), async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const { role, is_active, new_password, full_name, job_title } = req.body || {};

    if (role !== undefined && !['super_admin', 'committee_member', 'hr_coordinator'].includes(role)) {
      return res.status(400).json({ error: 'الدور الوظيفي غير صالح.' });
    }

    if (targetId === req.user.uid) {
      if (is_active === false) {
        return res.status(400).json({ error: 'لا يمكنك إيقاف حسابك الشخصي الحالي.' });
      }
      if (role !== undefined && role !== 'super_admin') {
        return res.status(400).json({ error: 'لا يمكنك تخفيض صلاحيات حسابك الحالي كمدير نظام.' });
      }
    }

    let pwdHash = null;
    if (new_password) {
      if (String(new_password).length < 8) {
        return res.status(400).json({ error: 'كلمة المرور الجديدة يجب ألا تقل عن 8 خانات.' });
      }
      pwdHash = hashPassword(new_password);
    }

    const { rows } = await query(
      `UPDATE staff_users SET
        role = COALESCE($1, role),
        is_active = COALESCE($2, is_active),
        password_hash = COALESCE($3, password_hash),
        full_name = COALESCE($4, full_name),
        job_title = COALESCE($5, job_title),
        updated_at = NOW()
       WHERE id = $6
       RETURNING id, username, full_name, job_title, role, is_active`,
      [
        role || null,
        typeof is_active === 'boolean' ? is_active : null,
        pwdHash,
        full_name || null,
        job_title || null,
        targetId
      ]
    );

    if (!rows.length) return res.status(404).json({ error: 'المستخدم غير موجود.' });

    await logAudit({
      actor: req.user.full_name,
      actorRole: req.user.role,
      action: 'STAFF_USER_UPDATED',
      entityType: 'staff_users',
      entityId: rows[0].username,
      metadata: { role: rows[0].role, is_active: rows[0].is_active, password_reset: Boolean(pwdHash) },
      ipAddress: req.ip
    });

    res.json({ user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------------
// 1. فحص جاهزية الخادم ومعمارية النظام (Health & Architecture & Ollama)
// ---------------------------------------------------------------------------------

app.get('/api/health', async (_req, res) => {
  const start = Date.now();
  try {
    const dbRes = await query(`
      SELECT
        current_database() AS db_name,
        (SELECT COUNT(*)::int FROM information_schema.tables WHERE table_schema = 'public') AS tables_count,
        (SELECT COUNT(*)::int FROM jobs WHERE is_active = TRUE) AS active_jobs
    `);
    res.json({
      status: 'ok',
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      latency_ms: Date.now() - start,
      node_version: process.version,
      database: dbRes.rows[0],
      security: {
        rbac_enabled: true,
        browser_secrets_stored: false,
        env_managed: true
      }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/system/architecture', requireAuth(), async (_req, res) => {
  try {
    const tablesRes = await query(`
      SELECT
        t.table_name,
        COALESCE(s.n_live_tup, 0)::int AS approx_rows,
        (SELECT COUNT(*)::int FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=t.table_name) AS columns_count
      FROM information_schema.tables t
      LEFT JOIN pg_stat_user_tables s ON s.relname = t.table_name
      WHERE t.table_schema = 'public'
      ORDER BY t.table_name;
    `);

    const fkRes = await query(`
      SELECT
        tc.table_name AS source_table,
        kcu.column_name AS source_column,
        ccu.table_name AS target_table,
        ccu.column_name AS target_column,
        tc.constraint_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      ORDER BY tc.table_name;
    `);

    const exactCounts = {};
    for (const row of tablesRes.rows) {
      const cnt = await query(`SELECT COUNT(*)::int AS c FROM "${row.table_name}"`);
      exactCounts[row.table_name] = cnt.rows[0].c;
    }

    res.json({
      tables: tablesRes.rows.map((r) => ({ ...r, exact_rows: exactCounts[r.table_name] ?? r.approx_rows })),
      foreign_keys: fkRes.rows,
      providers: getProvidersEnvStatus(),
      env_summary: {
        NODE_ENV: process.env.NODE_ENV || 'production',
        PORT,
        DATABASE_URL_CONFIGURED: Boolean(process.env.DATABASE_URL),
        MAX_UPLOAD_MB
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ollama/models', requireAuth(['super_admin']), async (req, res) => {
  try {
    const customUrl = req.query.base_url || undefined;
    const info = await listOllamaModels(customUrl);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ollama/test', requireAuth(['super_admin']), async (req, res) => {
  try {
    const { base_url, model } = req.body || {};
    if (!model) return res.status(400).json({ error: 'يرجى تحديد اسم موديل Ollama أولاً.' });
    const result = await testOllamaModel({ baseUrl: base_url, model });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `تعذر الاتصال بموديل Ollama: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------------
// 2. مسارات الوظائف وبنك الأسئلة (Jobs & JobBuilder)
// ---------------------------------------------------------------------------------

app.get('/api/jobs', async (req, res) => {
  try {
    const { department, search, include_inactive, mode } = req.query;
    const session = getSessionFromRequest(req);
    const isCommittee = Boolean(session) && mode === 'committee';

    const params = [];
    const where = [];

    if (!(Boolean(session) && include_inactive === '1')) {
      where.push('j.is_active = TRUE');
    }
    if (department && department !== 'الكل') {
      params.push(department);
      where.push(`j.department = $${params.length}`);
    }
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      where.push(`(j.title ILIKE $${params.length} OR j.code ILIKE $${params.length} OR j.summary ILIKE $${params.length} OR j.location ILIKE $${params.length})`);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT
        j.*,
        COUNT(a.id)::int AS applicants_count,
        COUNT(a.id) FILTER (WHERE a.status IN ('passed_assessment','under_review','interview_scheduled','interviewed','offered'))::int AS qualified_count
      FROM jobs j
      LEFT JOIN applications a ON a.job_id = j.id
      ${whereClause}
      GROUP BY j.id
      ORDER BY j.id ASC;
    `;

    const { rows } = await query(sql, params);
    const formatted = rows.map((job) => ({
      ...job,
      ai_prompt: isCommittee ? job.ai_prompt : undefined,
      passing_score: Number(job.passing_score),
      questions_count: Array.isArray(job.questions) ? job.questions.length : 10,
      questions: isCommittee ? job.questions : sanitizeQuestionsForCandidate(job.questions)
    }));

    res.json({ jobs: formatted });
  } catch (err) {
    res.status(500).json({ error: 'تعذر جلب قائمة الوظائف: ' + err.message });
  }
});

app.get('/api/jobs/:idOrCode', async (req, res) => {
  try {
    const { idOrCode } = req.params;
    const session = getSessionFromRequest(req);
    const isCommittee = Boolean(session) && req.query.mode === 'committee';

    const isNumericId = /^\d+$/.test(idOrCode);
    const { rows } = await query(
      `SELECT j.*, COUNT(a.id)::int AS applicants_count
       FROM jobs j
       LEFT JOIN applications a ON a.job_id = j.id
       WHERE ${isNumericId ? 'j.id = $1' : 'UPPER(j.code) = UPPER($1)'}
       GROUP BY j.id`,
      [isNumericId ? parseInt(idOrCode, 10) : idOrCode]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'الوظيفة المطلوبة غير موجودة.' });
    }

    const job = rows[0];
    res.json({
      job: {
        ...job,
        ai_prompt: isCommittee ? job.ai_prompt : undefined,
        passing_score: Number(job.passing_score),
        questions: isCommittee ? job.questions : sanitizeQuestionsForCandidate(job.questions)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jobs/generate-questions', requireAuth(['super_admin', 'hr_coordinator']), async (req, res) => {
  const { title = 'أخصائي مبيعات مشاريع', department = 'المبيعات', code = 'JB-100' } = req.body || {};
  const generated = [
    {
      index: 1,
      type: 'mcq',
      points: 10,
      question: `في دور (${title}) بقسم ${department}، ما الأولوية المهنية الأولى عند التعامل مع متطلبات عميل أو مشروع ذي مواصفات قياسية صارمة؟`,
      options: [
        'الالتزام الكامل بالمواصفة الفنية المعتمدة وتوثيق مراحل الاعتماد خطياً',
        'تجاوز الفحوصات القياسية لتسريع التسليم فقط',
        'تغيير المواصفات دون إشعار الإدارة أو الاستشاري',
        'تأجيل التوثيق إلى ما بعد إغلاق السنة المالية'
      ],
      correct_option: 0,
      explanation: 'الالتزام بالمواصفة الفنية والتوثيق المسبق هو أساس الجودة والحوكمة.'
    },
    {
      index: 2,
      type: 'numeric',
      points: 10,
      question: 'مشروع يتطلب تغطية 1,800 متر مربع بطبقتين من الطلاء، بمعدل تغطية 10 م² لكل لتر للطبقة الواحدة. كم لتراً يلزم للتوريد؟',
      correct_number: 360,
      tolerance: 2,
      unit: 'لتر'
    },
    {
      index: 3,
      type: 'mcq',
      points: 10,
      question: 'أي مؤشر يعكس الكفاءة التشغيلية والالتزام بالجودة في قطاع الدهانات والصناعات الهندسية؟',
      options: [
        'مطابقة المنتج لمواصفات SASO/ASTM مع تقليل نسبة المرتجعات والفاقد',
        'عدد الاجتماعات غير الموثقة',
        'إلغاء فحص العينات المرجعية',
        'عدم متابعة رضا العملاء بعد التوريد'
      ],
      correct_option: 0
    },
    {
      index: 4,
      type: 'text',
      points: 10,
      question: `صف خطة عملك خلال أول 30 يوماً لتحقيق نتائج ملموسة في وظيفة (${title}).`,
      keywords: ['تحليل', 'خطة', 'أهداف', 'متابعة', 'جودة', 'فريق', 'مؤشرات'],
      min_words: 18
    },
    {
      index: 5,
      type: 'numeric',
      points: 10,
      question: 'إذا كان المستهدف الشهري 50,000 ريال وتم تحقيق 42,500 ريال، فكم تبلغ نسبة الإنجاز المئوية؟',
      correct_number: 85,
      tolerance: 0.5,
      unit: '%'
    },
    {
      index: 6,
      type: 'mcq',
      points: 10,
      question: 'كيف تتعامل مع تعارض طارئ في الأولويات بين طلبيتين حرجتين في نفس اليوم؟',
      options: [
        'تقييم الأثر التعاقدي والزمني، والتنسيق الفوري مع الأطراف المعنية بجدول زمني محدث وشفاف',
        'تجاهل إحدى الطلبيتين دون إبلاغ أحد',
        'الانتظار حتى يقدم العميل شكوى رسمية',
        'إيقاف العمل على الطلبيتين معاً'
      ],
      correct_option: 0
    },
    {
      index: 7,
      type: 'text',
      points: 10,
      question: 'اذكر موقفاً عملياً واجهت فيه مشكلة فنية أو تشغيلية معقدة وكيف توصلت إلى السبب الجذري والحل المستدام.',
      keywords: ['مشكلة', 'سبب', 'حل', 'تنسيق', 'معالجة', 'نتيجة'],
      min_words: 18
    },
    {
      index: 8,
      type: 'mcq',
      points: 10,
      question: 'ما أهمية نشرات البيانات الفنية (TDS) وبيانات السلامة (MSDS) في بيئة العمل؟',
      options: [
        'مرجع إلزامي لضمان التطبيق الصحيح واشتراطات السلامة المهنية والاعتماد الهندسي',
        'مستندات شكلية لا علاقة لها بالموقع أو المختبر',
        'تُستخدم لأغراض الدعاية فقط',
        'تُقرأ بعد انتهاء المشروع فقط'
      ],
      correct_option: 0
    },
    {
      index: 9,
      type: 'text',
      points: 10,
      question: `ما أبرز قيمة مضافة ستقدمها لقسم (${department}) في شركة رُواء للدهانات بناءً على خبراتك السابقة؟`,
      keywords: ['خبرة', 'تطوير', 'كفاءة', 'التزام', 'إنجاز'],
      min_words: 15
    },
    {
      index: 10,
      type: 'portfolio',
      points: 10,
      question: `أرفق نموذج عمل سابق، شهادة مهنية، أو اكتب مقترحاً تطويرياً موجزاً لوظيفة (${title} - ${code}).`,
      keywords: ['تطوير', 'مشروع', 'تقرير', 'جودة', 'مؤشر']
    }
  ];

  const generatedPrompt = `أنت مستشار تقييم كفاءات خبير في قطاع الدهانات والصناعات الكيميائية. طبّق الفحص الأعمى (Blind Screening) لتقييم المتقدم لوظيفة (${title} - ${code}) في قسم (${department}). قيّم الدقة الرقمية، العمق التحليلي في المواقف العملية، ومطابقة الخبرة لمتطلبات الوظيفة، مع التحقق من مؤشر نزاهة الاختبار.`;

  res.json({ questions: generated, ai_prompt: generatedPrompt });
});

app.post('/api/jobs', requireAuth(['super_admin', 'hr_coordinator']), async (req, res) => {
  try {
    const {
      code, title, department, location, employment_type, experience_level, salary_range,
      accent_color, summary, description, responsibilities, requirements, ai_prompt,
      passing_score, duration_minutes, questions, is_active
    } = req.body;

    if (!code || !title || !department || !summary || !description || !ai_prompt) {
      return res.status(400).json({ error: 'يرجى تعبئة كافة الحقول الأساسية للوظيفة والبرومنت.' });
    }

    const deptColors = {
      'الإنتاج': '#C8553D',
      'المبيعات': '#E0A21B',
      'المشاريع': '#3B5B78',
      'الجودة': '#2F5D50',
      'المستودعات': '#7A5C43'
    };

    const { rows } = await query(
      `INSERT INTO jobs (
        code, title, department, location, employment_type, experience_level, salary_range,
        accent_color, summary, description, responsibilities, requirements, ai_prompt,
        passing_score, duration_minutes, questions, is_active
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16::jsonb,$17)
      RETURNING *`,
      [
        String(code).trim().toUpperCase(),
        String(title).trim(),
        department,
        location || 'جدة، المملكة العربية السعودية',
        employment_type || 'دوام كامل',
        experience_level || 'خبرة 2 - 5 سنوات',
        salary_range || 'يُحدد بعد المقابلة',
        accent_color || deptColors[department] || '#C8553D',
        summary,
        description,
        JSON.stringify(Array.isArray(responsibilities) ? responsibilities : []),
        JSON.stringify(Array.isArray(requirements) ? requirements : []),
        ai_prompt,
        Number(passing_score ?? 60),
        parseInt(duration_minutes || 20, 10),
        JSON.stringify(Array.isArray(questions) ? questions : []),
        is_active !== false
      ]
    );

    await logAudit({
      actor: req.user.full_name,
      actorRole: req.user.role,
      action: 'JOB_CREATED',
      entityType: 'job',
      entityId: rows[0].code,
      metadata: { title: rows[0].title, department: rows[0].department },
      ipAddress: req.ip
    });

    res.status(201).json({ job: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'كود الوظيفة مستخدم مسبقاً، يرجى اختيار كود وظيفي فريد.' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/jobs/:id', requireAuth(['super_admin', 'hr_coordinator']), async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const {
      title, department, location, employment_type, experience_level, salary_range,
      accent_color, summary, description, responsibilities, requirements, ai_prompt,
      passing_score, duration_minutes, questions, is_active
    } = req.body;

    const { rows } = await query(
      `UPDATE jobs SET
        title = COALESCE($1, title),
        department = COALESCE($2, department),
        location = COALESCE($3, location),
        employment_type = COALESCE($4, employment_type),
        experience_level = COALESCE($5, experience_level),
        salary_range = COALESCE($6, salary_range),
        accent_color = COALESCE($7, accent_color),
        summary = COALESCE($8, summary),
        description = COALESCE($9, description),
        responsibilities = COALESCE($10::jsonb, responsibilities),
        requirements = COALESCE($11::jsonb, requirements),
        ai_prompt = COALESCE($12, ai_prompt),
        passing_score = COALESCE($13, passing_score),
        duration_minutes = COALESCE($14, duration_minutes),
        questions = COALESCE($15::jsonb, questions),
        is_active = COALESCE($16, is_active),
        updated_at = NOW()
      WHERE id = $17
      RETURNING *`,
      [
        title || null,
        department || null,
        location || null,
        employment_type || null,
        experience_level || null,
        salary_range || null,
        accent_color || null,
        summary || null,
        description || null,
        responsibilities ? JSON.stringify(responsibilities) : null,
        requirements ? JSON.stringify(requirements) : null,
        ai_prompt || null,
        passing_score !== undefined ? Number(passing_score) : null,
        duration_minutes !== undefined ? parseInt(duration_minutes, 10) : null,
        questions ? JSON.stringify(questions) : null,
        typeof is_active === 'boolean' ? is_active : null,
        jobId
      ]
    );

    if (!rows.length) return res.status(404).json({ error: 'الوظيفة غير موجودة.' });

    await logAudit({
      actor: req.user.full_name,
      actorRole: req.user.role,
      action: 'JOB_UPDATED',
      entityType: 'job',
      entityId: rows[0].code,
      metadata: { passing_score: rows[0].passing_score, is_active: rows[0].is_active },
      ipAddress: req.ip
    });

    res.json({ job: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------------
// 3. التقديم ورفع السيرة الذاتية (مع فصل المؤهل العلمي عن التخصص)
// ---------------------------------------------------------------------------------

app.post('/api/applications', upload.single('cv_file'), async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      job_id,
      full_name,
      email,
      phone,
      city,
      years_experience,
      qualification,
      specialization,
      portfolio_url,
      cv_summary_notes,
      privacy_consent
    } = req.body;

    if (!job_id || !full_name || !email || !phone) {
      return res.status(400).json({ error: 'الاسم الكامل، البريد الإلكتروني، رقم الجوال، والوظيفة حقول إلزامية.' });
    }

    if (String(privacy_consent) !== 'true' && privacy_consent !== true && privacy_consent !== 'on') {
      return res.status(400).json({ error: 'يجب الموافقة على سياسة الخصوصية والإقرار بصحة البيانات للمتابعة.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'يرجى إرفاق ملف السيرة الذاتية بصيغة PDF أو DOCX.' });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanPhone = normalizePhoneForWa(phone);
    if (cleanPhone.length < 9) {
      return res.status(400).json({ error: 'يرجى إدخال رقم جوال صحيح (مثال: 0551234567).' });
    }

    const cleanQual = String(qualification || 'بكالوريوس').trim();
    const cleanSpec = String(specialization || '').trim();

    const jobRes = await client.query('SELECT * FROM jobs WHERE id = $1 AND is_active = TRUE', [parseInt(job_id, 10)]);
    if (!jobRes.rows.length) {
      return res.status(404).json({ error: 'الوظيفة المختارة غير متاحة حالياً للتقديم.' });
    }
    const job = jobRes.rows[0];

    const storedPath = `/uploads/${req.file.filename}`;
    const extracted = `${cleanSpec} ${cv_summary_notes || ''} ${extractReadableTextFromUpload(req.file.path, req.file.originalname)}`.trim();

    await client.query('BEGIN');

    const existingCand = await client.query(
      'SELECT * FROM candidates WHERE LOWER(email) = $1 OR phone = $2',
      [cleanEmail, cleanPhone]
    );

    let candidateId;
    if (existingCand.rows.length > 0) {
      // منع الدمج أو الاستحواذ عند تطابق جزئي للبريد أو الجوال مع مرشح آخر
      if (
        existingCand.rows.length > 1 ||
        String(existingCand.rows[0].email || '').trim().toLowerCase() !== cleanEmail ||
        normalizePhoneForWa(existingCand.rows[0].phone) !== cleanPhone
      ) {
        await client.query('ROLLBACK');
        safeUnlink(req.file?.path);
        return res.status(409).json({
          error: 'البريد الإلكتروني أو رقم الجوال مرتبط بسجل متقدم آخر ببيانات اتصال مختلفة. يرجى إدخال بياناتك المسجلة بدقة أو التواصل مع فريق التوظيف.',
          code: 'CANDIDATE_CONTACT_CONFLICT'
        });
      }

      candidateId = existingCand.rows[0].id;

      const priorAppsRes = await client.query(
        'SELECT id, job_id, reference_no, status, candidate_access_token FROM applications WHERE candidate_id = $1 ORDER BY id DESC',
        [candidateId]
      );
      const priorApps = priorAppsRes.rows;
      const dupApp = priorApps.find((a) => Number(a.job_id) === Number(job.id)) || null;
      const inputAccessKey = req.body?.access_key;

      // اشتراط إثبات الملكية التشفيري (كوكي الجلسة الأصلي أو مفتاح الدخول السري Access Key) قبل استئناف طلب أو تعديل ملف مرشح مسجل
      const targetProofSet = dupApp ? [dupApp] : priorApps;
      const isOwnerVerified = priorApps.length > 0 && hasCandidateOwnershipProof(req, targetProofSet, inputAccessKey);

      if (!isOwnerVerified) {
        await client.query('ROLLBACK');
        safeUnlink(req.file?.path);
        return res.status(403).json({
          error: 'توجد طلبات مسجلة مسبقاً لهذه البيانات. لحماية حسابك ومنع انتحال الهوية، يرجى إدخال مفتاح الدخول السري (Access Key) الصادر لك عند التقديم الأول، أو طلب رابط الاستعادة على جوالك المسجل عبر واتساب الموارد البشرية.',
          code: 'CANDIDATE_OWNERSHIP_PROOF_REQUIRED',
          requires_access_key: true
        });
      }

      if (dupApp) {
        await client.query('ROLLBACK');
        safeUnlink(req.file?.path);
        if (dupApp.status === 'assessment_pending') {
          const ct = createCandidatePortalToken(dupApp.reference_no, dupApp.candidate_access_token);
          const ak = deriveCandidateAccessKey(dupApp.reference_no, dupApp.candidate_access_token);
          setCandidateCookie(res, req, dupApp.reference_no, ct);
          return res.status(200).json({
            resumed: true,
            message: 'تم التحقق من ملكيتك للطلب؛ جاري نقلك لاستكمال اختبار الجدارة.',
            reference_no: dupApp.reference_no,
            candidate_token: ct,
            access_key: ak
          });
        }
        return res.status(409).json({
          error: `لقد قمت بالتقديم وإتمام التقييم مسبقاً على هذه الوظيفة برقم مرجعي (${dupApp.reference_no}). يمنع النظام تكرار الطلبات لنفس الوظيفة.`
        });
      }

      await client.query(
        `UPDATE candidates SET
          full_name = $1,
          city = $2,
          years_experience = $3,
          qualification = $4,
          specialization = $5,
          portfolio_url = COALESCE($6, portfolio_url),
          cv_filename = $7,
          cv_stored_path = $8,
          cv_extracted_text = $9,
          updated_at = NOW()
        WHERE id = $10`,
        [
          String(full_name).trim(),
          city || 'جدة',
          Math.max(0, parseFloat(years_experience || '0') || 0),
          cleanQual,
          cleanSpec,
          portfolio_url || null,
          req.file.originalname,
          storedPath,
          extracted,
          candidateId
        ]
      );
    } else {
      const insCand = await client.query(
        `INSERT INTO candidates (
          full_name, email, phone, city, years_experience, qualification, specialization,
          portfolio_url, cv_filename, cv_stored_path, cv_extracted_text
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING id`,
        [
          String(full_name).trim(),
          cleanEmail,
          cleanPhone,
          city || 'جدة',
          Math.max(0, parseFloat(years_experience || '0') || 0),
          cleanQual,
          cleanSpec,
          portfolio_url || null,
          req.file.originalname,
          storedPath,
          extracted
        ]
      );
      candidateId = insCand.rows[0].id;
    }

    const seqRes = await client.query('SELECT COALESCE(MAX(id), 0) + 1001 AS next_num FROM applications');
    const refNo = `APP-2026-${seqRes.rows[0].next_num}`;

    const appIns = await client.query(
      `INSERT INTO applications (reference_no, job_id, candidate_id, status, privacy_consent)
       VALUES ($1, $2, $3, 'assessment_pending', TRUE)
       RETURNING *`,
      [refNo, job.id, candidateId]
    );

    await client.query('COMMIT');

    const createdApp = appIns.rows[0];
    const candidatePortalToken = createCandidatePortalToken(refNo, createdApp.candidate_access_token);
    const candidateAccessKey = deriveCandidateAccessKey(refNo, createdApp.candidate_access_token);
    setCandidateCookie(res, req, refNo, candidatePortalToken);

    await logAudit({
      actor: String(full_name).trim(),
      actorRole: 'candidate',
      action: 'APPLICATION_SUBMITTED',
      entityType: 'application',
      entityId: refNo,
      metadata: { job_code: job.code, qualification: cleanQual, specialization: cleanSpec, city: city || 'جدة' },
      ipAddress: req.ip
    });

    res.status(201).json({
      message: 'تم حفظ بيانات التقديم والسيرة الذاتية بنجاح.',
      application: {
        id: createdApp.id,
        reference_no: createdApp.reference_no,
        job_id: createdApp.job_id,
        status: createdApp.status,
        submitted_at: createdApp.submitted_at
      },
      reference_no: refNo,
      candidate_token: candidatePortalToken,
      access_key: candidateAccessKey,
      job: { id: job.id, code: job.code, title: job.title, duration_minutes: job.duration_minutes }
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    safeUnlink(req.file?.path);
    res.status(500).json({ error: 'حدث خطأ أثناء حفظ الطلب: ' + err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------------
// 4. جلب بيانات الطلبات + بطاقة المقابلة العامة للمرشح (Visit Pass)
// ---------------------------------------------------------------------------------

app.get('/api/applications', requireAuth(), async (req, res) => {
  try {
    const { job_id, status, search } = req.query;
    const params = [];
    const where = [];

    if (job_id && job_id !== 'all') {
      params.push(parseInt(job_id, 10));
      where.push(`a.job_id = $${params.length}`);
    }
    if (status && status !== 'all') {
      params.push(status);
      where.push(`a.status = $${params.length}`);
    }
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      where.push(`(c.full_name ILIKE $${params.length} OR a.reference_no ILIKE $${params.length} OR c.email ILIKE $${params.length} OR j.code ILIKE $${params.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT
        a.*,
        c.full_name, c.email, c.phone, c.city, c.years_experience, c.qualification, c.specialization, c.cv_filename, c.cv_stored_path,
        j.code AS job_code, j.title AS job_title, j.department, j.accent_color, j.passing_score,
        i.scheduled_date, i.start_time, i.meeting_url, i.booking_status, i.interview_mode,
        (SELECT COUNT(*)::int FROM committee_evaluations ce WHERE ce.application_id = a.id) AS evaluations_count
      FROM applications a
      JOIN candidates c ON c.id = a.candidate_id
      JOIN jobs j ON j.id = a.job_id
      LEFT JOIN interviews i ON i.application_id = a.id
      ${whereSql}
      ORDER BY a.final_weighted_score DESC, a.submitted_at DESC`,
      params
    );

    const safeApplications = rows.map(({ candidate_access_token: _cat, voice_pitch_path: vp, ...row }) => {
      const voiceActive = isVoiceRowActive({ ...row, voice_pitch_path: vp });
      return {
        ...row,
        has_voice_pitch: voiceActive,
        voice_stream_url: voiceActive ? `/api/applications/${row.id}/voice-stream` : null
      };
    });
    res.json({ applications: safeApplications });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// تحقق ملكية المتقدم للطلب بإثبات حيازة تشفيري (مفتاح الدخول السري 100-bit Access Key — لا يُقبل البريد أو الجوال وحدهما أبداً)
app.post('/api/public/candidate-verify', candidateVerifyLimiter, async (req, res) => {
  try {
    const ref = String(req.body?.reference_no || '').trim().toUpperCase();
    const accessKey = String(req.body?.access_key || '').trim();
    if (!ref || !accessKey) {
      return res.status(400).json({
        error: 'يرجى إدخال الرقم المرجعي للطلب ومفتاح الدخول السري (Access Key) الصادر عند التقديم.',
        code: 'ACCESS_KEY_REQUIRED'
      });
    }

    const { rows } = await query(
      `SELECT a.reference_no, a.candidate_access_token
       FROM applications a
       WHERE UPPER(a.reference_no) = UPPER($1)
       LIMIT 1`,
      [ref]
    );

    if (!rows.length || !verifyCandidateAccessKey(accessKey, rows[0].reference_no, rows[0].candidate_access_token)) {
      return res.status(403).json({
        error: 'تعذر التحقق من مفتاح الدخول السري. تأكد من إدخال المفتاح الصحيح (JPFK-...) أو اطلب رابط استعادة على جوالك المسجل عبر واتساب الموارد البشرية.',
        code: 'INVALID_ACCESS_KEY'
      });
    }

    const row = rows[0];
    const ct = createCandidatePortalToken(row.reference_no, row.candidate_access_token);
    setCandidateCookie(res, req, row.reference_no, ct);
    res.json({ verified: true, reference_no: row.reference_no, candidate_token: ct });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// استعادة وصول المتقدم عبر قناة الاتصال المسجلة حصراً (تدوير الرمز السري وتجهيز رسالة واتساب للجوال المسجل في القاعدة فقط)
app.post('/api/applications/:id/recovery-link', requireAuth(['super_admin', 'hr_coordinator']), async (req, res) => {
  const client = await pool.connect();
  try {
    const appId = parseInt(req.params.id, 10);
    if (!Number.isInteger(appId) || appId <= 0) {
      return res.status(400).json({ error: 'معرّف الطلب غير صالح.' });
    }

    await client.query('BEGIN');

    // قفل صف الطلب أولاً لمنع التدوير المتزامن المزدوج وضمان إبطال أي رسائل استعادة قديمة
    const lockedApp = await client.query(
      'SELECT id FROM applications WHERE id = $1 FOR UPDATE',
      [appId]
    );
    if (!lockedApp.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الطلب غير موجود.' });
    }

    // إبطال كافة رسائل الاستعادة السابقة غير الملغاة المرتبطة بنفس الطلب قبل إصدار مسودة الاستعادة الجديدة
    await client.query(
      `UPDATE wa_messages
       SET queue_status = 'cancelled'
       WHERE application_id = $1
         AND template_key = 'portal_recovery'
         AND queue_status <> 'cancelled'`,
      [appId]
    );

    const newSecretNonce = crypto.randomBytes(32).toString('hex');
    const updRes = await client.query(
      `UPDATE applications a
       SET candidate_access_token = $1, updated_at = NOW()
       FROM candidates c, jobs j
       WHERE a.id = $2 AND c.id = a.candidate_id AND j.id = a.job_id
       RETURNING a.id, a.reference_no, a.status, a.assessment_score, a.candidate_access_token,
                 c.full_name, c.phone, j.title AS job_title, j.passing_score`,
      [newSecretNonce, appId]
    );

    if (!updRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الطلب غير موجود.' });
    }

    const row = updRes.rows[0];
    const origin = getBaseOrigin(req);
    const ct = createCandidatePortalToken(row.reference_no, row.candidate_access_token);
    const freshAccessKey = deriveCandidateAccessKey(row.reference_no, row.candidate_access_token);

    let targetPage = 'Assessment.dc.html';
    if (row.status !== 'assessment_pending') {
      targetPage = Number(row.assessment_score) >= Number(row.passing_score || 60) ? 'ResultPass.dc.html' : 'ResultFail.dc.html';
    }
    const recoveryUrl = `${origin}/${targetPage}?ref=${encodeURIComponent(row.reference_no)}&ct=${encodeURIComponent(ct)}`;

    const msgBody =
      `مرحباً ${row.full_name}،\n` +
      `بناءً على طلبك لاستعادة الوصول لطلب التوظيف (${row.reference_no}) لوظيفة (${row.job_title}):\n` +
      `🔗 رابط الدخول الشخصي المحدّث:\n${recoveryUrl}\n` +
      `🔑 مفتاح الدخول السري الجديد:\n${freshAccessKey}\n` +
      `(تم إبطال أي رابط أو مفتاح سابق لحماية خصوصيتك).`;

    const cleanRegisteredPhone = normalizePhoneForWa(row.phone);
    const waLink = buildWaLink(cleanRegisteredPhone, msgBody);

    const waIns = await client.query(
      `INSERT INTO wa_messages (
        application_id, template_key, recipient_name, recipient_phone, message_body, wa_link, queue_status
      ) VALUES ($1, 'portal_recovery', $2, $3, $4, $5, 'queued')
      RETURNING *`,
      [row.id, row.full_name, cleanRegisteredPhone, msgBody, waLink]
    );

    await client.query('COMMIT');

    await logAudit({
      actor: req.user.full_name,
      actorRole: req.user.role,
      action: 'CANDIDATE_RECOVERY_LINK_ROTATED',
      entityType: 'application',
      entityId: row.reference_no,
      metadata: { registered_phone_tail: cleanRegisteredPhone.slice(-4), wa_message_id: waIns.rows[0].id },
      ipAddress: req.ip
    });

    res.status(201).json({
      message: 'تم تدوير الرمز السري وتجهيز مسودة رابط الاستعادة للجوال المسجل فقط.',
      reference_no: row.reference_no,
      access_key: freshAccessKey,
      recovery_url: recoveryUrl,
      wa_link: waLink,
      wa_message: waIns.rows[0]
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/applications/:idOrRef', async (req, res) => {
  try {
    const { idOrRef } = req.params;
    const session = await resolveActiveStaffSession(req, query);
    const isNum = /^\d+$/.test(idOrRef);

    if (isNum && !session) {
      return res.status(401).json({ error: 'يلزم تسجيل الدخول بحساب اللجنة لاستعراض ملف المرشح.' });
    }

    const appRes = await query(
      `SELECT
        a.*,
        c.full_name, c.email, c.phone, c.city, c.years_experience, c.qualification, c.specialization,
        c.portfolio_url, c.cv_filename, c.cv_stored_path, c.cv_extracted_text,
        j.code AS job_code, j.title AS job_title, j.department, j.accent_color,
        j.passing_score, j.duration_minutes, j.questions AS job_questions, j.ai_prompt
      FROM applications a
      JOIN candidates c ON c.id = a.candidate_id
      JOIN jobs j ON j.id = a.job_id
      WHERE ${isNum ? 'a.id = $1' : 'UPPER(a.reference_no) = UPPER($1)'}`,
      [isNum ? parseInt(idOrRef, 10) : idOrRef]
    );

    if (!appRes.rows.length) {
      if (!session) {
        const locCfg = await getCompanyLocationConfig();
        return res.status(403).json({
          error: 'يلزم إثبات ملكية الطلب عبر مفتاح الدخول السري (Access Key) الصادر عند التقديم.',
          code: 'CANDIDATE_VERIFY_REQUIRED',
          requires_verification: true,
          reference_no: String(idOrRef).toUpperCase(),
          hr_whatsapp_phone: locCfg.hr_whatsapp_phone || '966550000000'
        });
      }
      return res.status(404).json({ error: 'لم يتم العثور على الطلب المطلوب.' });
    }

    const application = appRes.rows[0];
    const isCommittee = Boolean(session) && req.query.mode === 'committee';

    // مسار المتقدم العام: محمي برمز مقيّد بالغرض (candidate_portal) + تقليص صارم للبيانات (Data Minimization)
    if (!session) {
      const candToken = extractCandidateTokenFromRequest(req, application.reference_no);
      const isAuthorizedCandidate = verifyCandidatePortalToken(
        candToken,
        application.reference_no,
        application.candidate_access_token
      );

      if (!isAuthorizedCandidate) {
        const locCfg = await getCompanyLocationConfig();
        return res.status(403).json({
          error: 'لحماية خصوصية المتقدمين، يرجى إدخال مفتاح الدخول السري (Access Key) الصادر لك عند التقديم.',
          code: 'CANDIDATE_VERIFY_REQUIRED',
          requires_verification: true,
          reference_no: application.reference_no,
          hr_whatsapp_phone: locCfg.hr_whatsapp_phone || '966550000000'
        });
      }

      // تجديد الكوكي في حال مرر الرمز عبر الرابط لضمان استمرارية الجلسة دون تسريبه
      setCandidateCookie(res, req, application.reference_no, candToken);

      const [interviewRes, locConfig, voiceCfg] = await Promise.all([
        query(
          `SELECT id, visit_token, scheduled_date, start_time, duration_minutes, booking_status, interview_mode
           FROM interviews WHERE application_id = $1`,
          [application.id]
        ),
        getCompanyLocationConfig(),
        getVoicePitchFeatureConfig()
      ]);

      const origin = getBaseOrigin(req);
      const intRow = interviewRes.rows[0] || null;
      const candVoiceActive = isVoiceRowActive(application);

      return res.json({
        application: {
          reference_no: application.reference_no,
          job_id: application.job_id,
          status: application.status,
          ai_analysis_status: application.ai_analysis_status || 'completed',
          full_name: application.full_name,
          job_code: application.job_code,
          job_title: application.job_title,
          passing_score: application.passing_score,
          duration_minutes: application.duration_minutes,
          assessment_score: application.assessment_score,
          cv_match_score: application.cv_match_score,
          ai_overall_score: application.ai_overall_score,
          integrity_score: application.integrity_score,
          assessed_at: application.assessed_at,
          voice_pitch_enabled: voiceCfg.enabled,
          has_voice_pitch: candVoiceActive,
          voice_duration_sec: candVoiceActive ? (application.voice_duration_sec || null) : null,
          voice_recorded_at: application.voice_recorded_at || null,
          voice_retention_expires_at: application.voice_retention_expires_at || null,
          voice_purged_at: application.voice_purged_at || null,
          ai_report: sanitizeReportForCandidate(application.ai_report),
          job_questions: application.status === 'assessment_pending'
            ? sanitizeQuestionsForCandidate(application.job_questions)
            : []
        },
        interview: intRow
          ? {
              scheduled_date: intRow.scheduled_date,
              start_time: intRow.start_time,
              duration_minutes: intRow.duration_minutes,
              booking_status: intRow.booking_status,
              interview_mode: intRow.interview_mode || 'remote',
              visit_url: buildVisitPassUrl(origin, intRow.id, intRow.visit_token)
            }
          : null,
        hr_whatsapp_phone: locConfig.hr_whatsapp_phone || '966550000000'
      });
    }

    const [answersRes, evalsRes, interviewRes] = await Promise.all([
      query('SELECT * FROM assessment_answers WHERE application_id = $1 ORDER BY question_index ASC', [application.id]),
      query('SELECT * FROM committee_evaluations WHERE application_id = $1 ORDER BY evaluated_at DESC', [application.id]),
      query('SELECT * FROM interviews WHERE application_id = $1', [application.id])
    ]);

    const { candidate_access_token: _staffHiddenCat, voice_pitch_path: rawVp, ...safeStaffApp } = application;
    const rawInt = interviewRes.rows[0] || null;
    let safeStaffInt = null;
    if (rawInt) {
      const { visit_token: rawVt, ...restInt } = rawInt;
      safeStaffInt = {
        ...restInt,
        visit_url: buildVisitPassUrl(getBaseOrigin(req), rawInt.id, rawVt)
      };
    }

    const staffVoiceActive = isVoiceRowActive(application);
    res.json({
      application: {
        ...safeStaffApp,
        has_voice_pitch: staffVoiceActive,
        voice_stream_url: staffVoiceActive ? `/api/applications/${application.id}/voice-stream` : null,
        job_questions: isCommittee
          ? application.job_questions
          : sanitizeQuestionsForCandidate(application.job_questions)
      },
      answers: answersRes.rows,
      evaluations: evalsRes.rows,
      interview: safeStaffInt
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// بطاقة زيارة المقابلة وتأكيد الحضور للمرشح — محمية برمز غير قابل للتخمين ومقيّد بالغرض (visit_pass)
app.get('/api/public/visit/:vt', async (req, res) => {
  try {
    const rawToken = String(req.params.vt || '').trim();
    const parsed = verifyVisitPassToken(rawToken);
    if (!parsed) {
      return res.status(403).json({
        error: 'رابط بطاقة المقابلة غير صالح أو منتهي الصلاحية. يرجى فتح الرابط الرسمي المرسل إليك في رسالة الدعوة.',
        code: 'INVALID_VISIT_TOKEN'
      });
    }

    const intId = parseInt(parsed.sub, 10);
    if (!Number.isInteger(intId) || intId <= 0) {
      return res.status(403).json({ error: 'رمز البطاقة غير صالح.', code: 'INVALID_VISIT_TOKEN' });
    }

    const [intRes, locCfg] = await Promise.all([
      query(
        `SELECT i.*, a.reference_no, a.status AS app_status, c.full_name,
                j.code AS job_code, j.title AS job_title, j.department
         FROM interviews i
         JOIN applications a ON a.id = i.application_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN jobs j ON j.id = a.job_id
         WHERE i.id = $1`,
        [intId]
      ),
      getCompanyLocationConfig()
    ]);

    if (!intRes.rows.length) {
      return res.status(404).json({ error: 'لم يتم العثور على بطاقة المقابلة.' });
    }

    const interview = intRes.rows[0];
    const expectedNonce = String(interview.visit_token || '').slice(0, 32);
    const aBuf = Buffer.from(String(parsed.n));
    const bBuf = Buffer.from(expectedNonce);
    if (!expectedNonce || aBuf.length !== bBuf.length || !crypto.timingSafeEqual(aBuf, bBuf)) {
      return res.status(403).json({ error: 'انتهت صلاحية هذا الرابط أو تم تحديث الموعد.', code: 'REVOKED_VISIT_TOKEN' });
    }

    let checkinQrSvg = null;
    let checkinQrPayload = null;
    if (!['cancelled', 'no_show'].includes(interview.booking_status)) {
      checkinQrPayload = `JPFQR:${createReceptionQrToken(interview.id, interview.visit_token)}`;
      checkinQrSvg = await QRCode.toString(checkinQrPayload, {
        type: 'svg',
        margin: 1,
        width: 210,
        errorCorrectionLevel: 'M',
        color: { dark: '#1F2421', light: '#FFFFFF' }
      });
    }

    res.json({
      candidate: {
        reference_no: interview.reference_no,
        full_name: interview.full_name,
        job_code: interview.job_code,
        job_title: interview.job_title,
        department: interview.department
      },
      interview: {
        interview_mode: interview.interview_mode || 'remote',
        scheduled_date: interview.scheduled_date,
        start_time: interview.start_time,
        end_time: interview.end_time,
        duration_minutes: interview.duration_minutes,
        booking_status: interview.booking_status,
        lobby_status: interview.lobby_status || 'not_arrived',
        checked_in_at: interview.checked_in_at || null,
        punctuality_minutes: interview.punctuality_minutes ?? null,
        checkin_code_tail: String(interview.reference_no || '').slice(-4),
        checkin_qr_payload: checkinQrPayload,
        checkin_qr_svg: checkinQrSvg,
        meeting_platform: interview.meeting_platform,
        meeting_url: interview.interview_mode === 'in_person' ? null : interview.meeting_url,
        // v2.4: رابط القاعة الخاصة (إن كانت الغرفة مثبتة) — يُمنح للمرشح كـ participant بلا توكن إدارة
        jitsi_room_url: interview.interview_mode === 'in_person' || !interview.jitsi_room_name
          ? null
          : jitsiClient.buildRoomSession({
              roomName: interview.jitsi_room_name,
              role: 'participant',
              displayName: interview.full_name
            }).join_url,
        interviewer_panel: interview.interviewer_panel,
        building: interview.location_building || locCfg.building_name,
        address_line: locCfg.address_line || '',
        floor: interview.location_floor || locCfg.floor_number,
        office: interview.location_office || locCfg.office_number,
        maps_url: interview.location_maps_url || locCfg.google_maps_url,
        entrance_image_url: interview.location_image_url || locCfg.entrance_image_url || '/img/hq-entrance.svg',
        arrival_instructions: interview.location_notes || locCfg.arrival_instructions
      },
      hr_whatsapp_phone: locCfg.hr_whatsapp_phone || '966550000000'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/public/visit/:vt/confirm', candidateVerifyLimiter, async (req, res) => {
  const rawToken = String(req.params.vt || '').trim();
  const parsed = verifyVisitPassToken(rawToken);
  if (!parsed) {
    return res.status(403).json({
      error: 'رمز تأكيد الحضور غير صالح أو غير مصرح به.',
      code: 'INVALID_VISIT_TOKEN'
    });
  }

  const intId = parseInt(parsed.sub, 10);
  if (!Number.isInteger(intId) || intId <= 0) {
    return res.status(403).json({ error: 'رمز تأكيد الحضور غير صالح.', code: 'INVALID_VISIT_TOKEN' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // قفل صف الموعد ذرياً (FOR UPDATE) لمنع تعارض التأكيد المتزامن مع إعادة الجدولة أو تدوير الرمز
    const checkRes = await client.query(
      `SELECT i.id, i.visit_token, i.booking_status, a.reference_no, c.full_name
       FROM interviews i
       JOIN applications a ON a.id = i.application_id
       JOIN candidates c ON c.id = a.candidate_id
       WHERE i.id = $1
       FOR UPDATE OF i`,
      [intId]
    );
    if (!checkRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'المقابلة غير موجودة.' });
    }

    const currentInt = checkRes.rows[0];
    const expectedNonce = String(currentInt.visit_token || '').slice(0, 32);
    const aBuf = Buffer.from(String(parsed.n));
    const bBuf = Buffer.from(expectedNonce);
    if (!expectedNonce || aBuf.length !== bBuf.length || !crypto.timingSafeEqual(aBuf, bBuf)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'رمز تأكيد الحضور ملغى أو منتهي الصلاحية.', code: 'REVOKED_VISIT_TOKEN' });
    }

    if (['cancelled', 'completed', 'no_show'].includes(currentInt.booking_status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'هذا الموعد غير متاح للتأكيد حالياً، يرجى التواصل مع منسق التوظيف.' });
    }

    // لا يُسمح بتأكيد حضور موعد لم تُرسل دعوته فعلياً بعد (scheduled / rescheduled)
    if (!['invitation_sent', 'confirmed'].includes(currentInt.booking_status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'لم يتم تفعيل تأكيد الحضور لهذا الموعد بعد؛ بانتظار إرسال الدعوة الرسمية المحدّثة من منسق التوظيف.',
        code: 'INVITATION_NOT_SENT_YET'
      });
    }

    // تحديث ذري مقيد بشرط مطابقة الرمز والحالة في نفس الجملة داخل المعاملة المقفلة
    const updInt = await client.query(
      `UPDATE interviews
       SET booking_status = 'confirmed', updated_at = NOW()
       WHERE id = $1
         AND LEFT(visit_token, 32) = $2
         AND booking_status IN ('invitation_sent', 'confirmed')
       RETURNING id`,
      [currentInt.id, expectedNonce]
    );
    if (!updInt.rows.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'تعذر التأكيد لتحديث الموعد بالتزامن؛ يرجى فتح الرابط الجديد.', code: 'REVOKED_VISIT_TOKEN' });
    }

    // تحديث الرسائل المرسلة فعلياً فقط (sent) إلى confirmed — لا تتحول رسائل الطابور غير المرسلة (queued) إلى confirmed أبداً
    await client.query(
      `UPDATE wa_messages SET queue_status = 'confirmed' WHERE interview_id = $1 AND queue_status = 'sent'`,
      [currentInt.id]
    );

    await client.query('COMMIT');

    await logAudit({
      actor: currentInt.full_name,
      actorRole: 'candidate',
      action: 'INTERVIEW_CONFIRMED_BY_CANDIDATE',
      entityType: 'interview',
      entityId: currentInt.reference_no,
      ipAddress: req.ip
    });

    res.json({ message: 'تم تأكيد حضورك للمقابلة بنجاح! نتطلع للقائك.', booking_status: 'confirmed' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.patch('/api/applications/:id/status', requireAuth(['super_admin', 'hr_coordinator']), async (req, res) => {
  const client = await pool.connect();
  try {
    const appId = parseInt(req.params.id, 10);
    const { status } = req.body || {};
    const allowedManualStatuses = ['under_review', 'offered', 'rejected'];
    if (!allowedManualStatuses.includes(status)) {
      return res.status(400).json({
        error: 'الحالة المطلوبة غير مسموح بتعيينها يدوياً؛ الحالات المتاحة لقرار التوظيف هي: قيد المراجعة، عرض وظيفي، أو اعتذار.',
        code: 'INVALID_APPLICATION_STATUS_TRANSITION'
      });
    }

    await client.query('BEGIN');
    const curRes = await client.query('SELECT * FROM applications WHERE id = $1 FOR UPDATE', [appId]);
    if (!curRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الطلب غير موجود.' });
    }
    const curApp = curRes.rows[0];

    if (curApp.status === 'assessment_pending' && status !== 'rejected') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'لا يمكن نقل طلب لم يُكمل الاختبار بعد إلى مرحلة المراجعة أو العرض الوظيفي.',
        code: 'INVALID_APPLICATION_STATUS_TRANSITION'
      });
    }

    const { rows } = await client.query(
      `UPDATE applications
       SET status = $1::varchar,
           voice_retention_expires_at = CASE
             WHEN $1::varchar = 'offered' THEN NULL
             WHEN voice_pitch_path IS NOT NULL AND voice_retention_expires_at IS NULL
               THEN COALESCE(voice_recorded_at, NOW()) + INTERVAL '30 days'
             ELSE voice_retention_expires_at
           END,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [status, appId]
    );

    // اتساق الحالات عبر الكيانات: عند الاعتذار لمرشح لديه موعد غير مكتمل، يُلغى الموعد وتُبطل بطاقة الزيارة ودعوات الطابور تلقائياً
    if (status === 'rejected') {
      const openIntRes = await client.query(
        `SELECT id, booking_status FROM interviews WHERE application_id = $1 FOR UPDATE`,
        [appId]
      );
      if (openIntRes.rows.length > 0 && !['completed', 'cancelled'].includes(openIntRes.rows[0].booking_status)) {
        const revokedVt = crypto.randomBytes(32).toString('hex');
        await client.query(
          `UPDATE interviews
           SET booking_status = 'cancelled',
               visit_token = $1,
               lobby_status = 'not_arrived',
               checked_in_at = NULL,
               checked_in_by = NULL,
               punctuality_minutes = NULL,
               updated_at = NOW()
           WHERE id = $2`,
          [revokedVt, openIntRes.rows[0].id]
        );
      }
      await client.query(
        `UPDATE wa_messages
         SET queue_status = 'cancelled'
         WHERE application_id = $1
           AND template_key <> 'portal_recovery'
           AND queue_status <> 'cancelled'`,
        [appId]
      );
    }

    await client.query('COMMIT');

    await logAudit({
      actor: req.user.full_name,
      actorRole: req.user.role,
      action: 'APPLICATION_STATUS_CHANGED',
      entityType: 'application',
      entityId: rows[0].reference_no,
      metadata: { previous_status: curApp.status, new_status: status },
      ipAddress: req.ip
    });

    const { candidate_access_token: _catHidden, ...safeApplication } = rows[0];
    res.json({ application: safeApplication });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------------
// 5. اختبار الجدارة غير المتزامن (فوري بلا تعليق + عداد 60 ثانية + استطلاع حي)
// ---------------------------------------------------------------------------------

app.post('/api/assessments/upload-attachment', async (req, res, next) => {
  try {
    const staff = await resolveActiveStaffSession(req, query);
    if (staff) {
      req.user = staff;
      return next();
    }

    const allTokens = extractAllCandidateTokensFromRequest(req);
    let verifiedPendingApp = null;
    for (const tok of allTokens) {
      const parsed = verifyScopedToken(tok, 'candidate_portal');
      if (!parsed || !parsed.sub) continue;
      const appCheck = await query(
        'SELECT id, reference_no, status, candidate_access_token FROM applications WHERE UPPER(reference_no) = UPPER($1) LIMIT 1',
        [parsed.sub]
      );
      if (
        appCheck.rows.length > 0 &&
        appCheck.rows[0].status === 'assessment_pending' &&
        verifyCandidatePortalToken(tok, appCheck.rows[0].reference_no, appCheck.rows[0].candidate_access_token)
      ) {
        verifiedPendingApp = appCheck.rows[0];
        break;
      }
    }

    if (!verifiedPendingApp) {
      return res.status(403).json({
        error: 'يلزم جلسة متقدم نشطة وغير منتهية وطلب قيد الاختبار لرفع مرفقات الاختبار.',
        code: 'CANDIDATE_ATTACHMENT_FORBIDDEN'
      });
    }
    req.verifiedCandidateApp = verifiedPendingApp;
    next();
  } catch (err) {
    next(err);
  }
}, upload.single('attachment_file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'لم يتم اختيار ملف صالح.' });
  }
  res.json({
    attachment_path: `/uploads/${req.file.filename}`,
    original_name: req.file.originalname,
    size_kb: Math.round(req.file.size / 1024)
  });
});

app.get('/api/assessments/status/:ref', async (req, res) => {
  try {
    const ref = String(req.params.ref || '').trim();
    const staff = await resolveActiveStaffSession(req, query);
    const [appRes, locCfg] = await Promise.all([
      query(
        `SELECT a.reference_no, a.status, a.ai_analysis_status, a.assessment_score, a.ai_overall_score,
                a.candidate_access_token, c.full_name, j.title AS job_title, j.code AS job_code, j.passing_score
         FROM applications a
         JOIN candidates c ON c.id = a.candidate_id
         JOIN jobs j ON j.id = a.job_id
         WHERE UPPER(a.reference_no) = UPPER($1)`,
        [ref]
      ),
      getCompanyLocationConfig()
    ]);

    if (!appRes.rows.length) {
      return res.status(403).json({ error: 'غير مصرح بالوصول إلى حالة هذا الطلب.' });
    }
    const row = appRes.rows[0];

    if (!staff) {
      const candTok = extractCandidateTokenFromRequest(req, row.reference_no);
      if (!verifyCandidatePortalToken(candTok, row.reference_no, row.candidate_access_token)) {
        return res.status(403).json({ error: 'غير مصرح بالوصول إلى حالة هذا الطلب.', code: 'CANDIDATE_VERIFY_REQUIRED' });
      }
    }

    const passed = Number(row.assessment_score) >= Number(row.passing_score || 60);
    const analysisDone = row.status !== 'assessment_pending' && (row.ai_analysis_status === 'completed' || row.ai_analysis_status === 'fallback');

    res.json({
      reference_no: row.reference_no,
      full_name: row.full_name,
      job_title: row.job_title,
      job_code: row.job_code,
      status: row.status,
      ai_analysis_status: row.ai_analysis_status || 'completed',
      ready: analysisDone,
      passed,
      assessment_score: Number(row.assessment_score),
      hr_whatsapp_phone: locCfg.hr_whatsapp_phone || '966550000000',
      redirect_url: `${passed ? 'ResultPass.dc.html' : 'ResultFail.dc.html'}?ref=${encodeURIComponent(row.reference_no)}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/assessments/submit', async (req, res) => {
  const client = await pool.connect();
  try {
    const { reference_no, application_id, answers = [], telemetry = {} } = req.body;
    if (!reference_no && !application_id) {
      return res.status(400).json({ error: 'معرّف الطلب مفقود.' });
    }

    const staff = await resolveActiveStaffSession(req, query);
    if (application_id && !staff) {
      return res.status(403).json({ error: 'غير مصرح بإرسال الاختبار بمعرّف داخلي.' });
    }

    await client.query('BEGIN');

    // قفل صف الطلب (FOR UPDATE OF a) لمنع الإرسال المتزامن المزدوج وضمان الإدمبوتنسي الذرية
    const appRes = await client.query(
      `SELECT a.*, c.full_name, c.email, c.phone, c.years_experience, c.qualification, c.specialization,
              c.portfolio_url, c.cv_filename, c.cv_stored_path, c.cv_extracted_text
       FROM applications a
       JOIN candidates c ON c.id = a.candidate_id
       WHERE ${application_id ? 'a.id = $1' : 'UPPER(a.reference_no) = UPPER($1)'}
       FOR UPDATE OF a`,
      [application_id ? parseInt(application_id, 10) : reference_no]
    );

    if (!appRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'غير مصرح بالوصول إلى هذا الطلب.' });
    }
    const appRow = appRes.rows[0];

    if (!staff) {
      const candTok = extractCandidateTokenFromRequest(req, appRow.reference_no);
      if (!verifyCandidatePortalToken(candTok, appRow.reference_no, appRow.candidate_access_token)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'يلزم التحقق من ملكية الطلب قبل إرسال الاختبار.', code: 'CANDIDATE_VERIFY_REQUIRED' });
      }
      setCandidateCookie(res, req, appRow.reference_no, candTok);
    }
    const locCfg = await getCompanyLocationConfig();

    if (appRow.assessed_at && appRow.status !== 'assessment_pending') {
      await client.query('ROLLBACK');
      const alreadyPassed = Number(appRow.assessment_score) >= 60;
      return res.status(200).json({
        already_submitted: true,
        reference_no: appRow.reference_no,
        full_name: appRow.full_name,
        passed: alreadyPassed,
        ai_analysis_status: appRow.ai_analysis_status || 'completed',
        ready: (appRow.ai_analysis_status || 'completed') !== 'processing',
        hr_whatsapp_phone: locCfg.hr_whatsapp_phone || '966550000000',
        redirect_url: `${alreadyPassed ? 'ResultPass.dc.html' : 'ResultFail.dc.html'}?ref=${encodeURIComponent(appRow.reference_no)}`
      });
    }

    const jobRes = await client.query('SELECT * FROM jobs WHERE id = $1', [appRow.job_id]);
    const job = jobRes.rows[0];

    const settingsRes = await client.query("SELECT setting_value FROM system_settings WHERE setting_key = 'ai_engine_config'");
    const aiConfig = settingsRes.rows[0]?.setting_value || {};
    const requestedProvider = aiConfig.active_provider || process.env.AI_DEFAULT_PROVIDER || 'smart-rubric';
    const usesAsyncAI = requestedProvider !== 'smart-rubric';

    // 1. تصحيح فوري وحفظ النتيجة في قاعدة البيانات خلال أجزاء من الثانية لمنع أي تعليق!
    const baseEval = evaluateDeterministicInstant({
      job,
      candidate: appRow,
      answers,
      telemetry,
      aiConfig
    });

    const newStatus = baseEval.passed ? 'passed_assessment' : 'failed_assessment';
    const timeSpent = Math.max(0, parseInt(telemetry.time_spent_seconds || 0, 10) || 0);
    const tabSwitches = Math.max(0, parseInt(telemetry.tab_switches || 0, 10) || 0);
    const pasteAttempts = Math.max(0, parseInt(telemetry.paste_attempts || 0, 10) || 0);
    const initialAiStatus = usesAsyncAI ? 'processing' : 'completed';

    await client.query('DELETE FROM assessment_answers WHERE application_id = $1', [appRow.id]);

    for (const item of baseEval.gradedItems) {
      await client.query(
        `INSERT INTO assessment_answers (
          application_id, question_index, question_type, question_text,
          answer_value, attachment_path, max_points, awarded_points, ai_feedback, time_taken_seconds
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          appRow.id,
          item.question_index,
          item.question_type,
          item.question_text,
          item.answer_value,
          item.attachment_path,
          item.max_points,
          item.awarded_points,
          item.ai_feedback,
          item.time_taken_seconds
        ]
      );
    }

    await client.query(
      `UPDATE applications SET
        status = $1,
        cv_match_score = $2,
        assessment_score = $3,
        ai_overall_score = $4,
        integrity_score = $5,
        tab_switches = $6,
        paste_attempts = $7,
        time_spent_seconds = $8,
        ai_report = $9::jsonb,
        ai_analysis_status = $10,
        assessed_at = NOW(),
        updated_at = NOW()
      WHERE id = $11`,
      [
        newStatus,
        baseEval.cvMatchScore,
        baseEval.assessmentScore,
        baseEval.aiOverallScore,
        baseEval.integrityScore,
        tabSwitches,
        pasteAttempts,
        timeSpent,
        JSON.stringify(baseEval.aiReport),
        initialAiStatus,
        appRow.id
      ]
    );

    await client.query('SELECT fn_sync_application_weighted_score($1)', [appRow.id]);
    await client.query('COMMIT');

    const redirectUrl = `${baseEval.passed ? 'ResultPass.dc.html' : 'ResultFail.dc.html'}?ref=${encodeURIComponent(appRow.reference_no)}`;

    // 2. إذا كان Ollama أو مزود خارجي مفعلاً، يشتغل في الخلفية فور إرجاع الاستجابة للمتصفح!
    if (usesAsyncAI) {
      setImmediate(async () => {
        try {
          const enrichedReport = await enrichReportWithExternalAI({
            job,
            candidate: appRow,
            baseEval,
            aiConfig
          });
          await query(
            `UPDATE applications
             SET ai_report = $1::jsonb, ai_analysis_status = 'completed', updated_at = NOW()
             WHERE id = $2`,
            [JSON.stringify(enrichedReport), appRow.id]
          );
          await logAudit({
            actor: `محرك التحليل (${enrichedReport.provider_used})`,
            actorRole: 'ai_engine',
            action: 'ASSESSMENT_AI_ENRICHED',
            entityType: 'application',
            entityId: appRow.reference_no,
            metadata: { provider: enrichedReport.provider_used, score: baseEval.assessmentScore }
          });
        } catch (bgErr) {
          console.error('[Async AI Error]:', bgErr.message);
          await query(
            `UPDATE applications SET ai_analysis_status = 'fallback', updated_at = NOW() WHERE id = $1`,
            [appRow.id]
          ).catch(() => {});
        }
      });
    } else {
      await logAudit({
        actor: 'محرك التقييم المدمج (smart-rubric)',
        actorRole: 'ai_engine',
        action: 'ASSESSMENT_SUBMITTED_AND_GRADED',
        entityType: 'application',
        entityId: appRow.reference_no,
        metadata: { assessment_score: baseEval.assessmentScore, passed: baseEval.passed },
        ipAddress: req.ip
      });
    }

    res.json({
      message: 'تم استلام وحفظ إجاباتك بنجاح، جاري استكمال التحليل الذكي.',
      reference_no: appRow.reference_no,
      full_name: appRow.full_name,
      job_title: job.title,
      job_code: job.code,
      passed: baseEval.passed,
      ready: !usesAsyncAI,
      ai_analysis_status: initialAiStatus,
      assessment_score: baseEval.assessmentScore,
      hr_whatsapp_phone: locCfg.hr_whatsapp_phone || '966550000000',
      redirect_url: redirectUrl
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'تعذر معالجة إجابات الاختبار: ' + err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------------
// 6. إحصائيات لوحة التحكم المركزية
// ---------------------------------------------------------------------------------

app.get('/api/stats', requireAuth(), async (_req, res) => {
  try {
    const kpiRes = await query(`
      SELECT
        (SELECT COUNT(*)::int FROM jobs WHERE is_active = TRUE) AS active_jobs,
        COUNT(*)::int AS total_applications,
        COUNT(*) FILTER (WHERE status != 'assessment_pending')::int AS assessed_count,
        COUNT(*) FILTER (WHERE status IN ('passed_assessment','under_review','interview_scheduled','interviewed','offered'))::int AS passed_count,
        COUNT(*) FILTER (WHERE status = 'failed_assessment')::int AS failed_count,
        COUNT(*) FILTER (WHERE committee_avg_score > 0)::int AS evaluated_by_committee,
        COUNT(*) FILTER (WHERE status IN ('interview_scheduled','interviewed','offered'))::int AS interview_stage_count,
        COUNT(*) FILTER (WHERE status = 'offered')::int AS offered_count,
        COALESCE(ROUND(AVG(ai_overall_score) FILTER (WHERE ai_overall_score > 0), 1), 0) AS avg_ai_score,
        COALESCE(ROUND(AVG(integrity_score), 1), 100) AS avg_integrity_score,
        (SELECT COUNT(*)::int FROM interviews WHERE scheduled_date = CURRENT_DATE) AS today_interviews_count,
        (SELECT COUNT(*)::int FROM wa_messages WHERE queue_status = 'queued') AS pending_wa_count
      FROM applications;
    `);

    const dailyRes = await query(`
      SELECT
        TO_CHAR(d.day, 'MM-DD') AS label,
        d.day::date AS full_date,
        COUNT(a.id)::int AS count,
        COUNT(a.id) FILTER (WHERE a.assessment_score >= 60)::int AS passed
      FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') AS d(day)
      LEFT JOIN applications a ON DATE(a.submitted_at AT TIME ZONE 'Asia/Riyadh') = d.day::date
      GROUP BY d.day
      ORDER BY d.day ASC;
    `);

    const recentRes = await query(`
      SELECT
        a.id, a.reference_no, a.status, a.assessment_score, a.ai_overall_score,
        a.committee_avg_score, a.final_weighted_score, a.integrity_score, a.submitted_at,
        c.full_name, c.city, c.qualification, c.specialization,
        j.code AS job_code, j.title AS job_title, j.department, j.accent_color
      FROM applications a
      JOIN candidates c ON c.id = a.candidate_id
      JOIN jobs j ON j.id = a.job_id
      ORDER BY a.submitted_at DESC
      LIMIT 8;
    `);

    const todayInterviewsRes = await query(`
      SELECT
        i.*,
        a.reference_no, a.final_weighted_score,
        c.full_name, c.phone,
        j.code AS job_code, j.title AS job_title, j.accent_color
      FROM interviews i
      JOIN applications a ON a.id = i.application_id
      JOIN candidates c ON c.id = a.candidate_id
      JOIN jobs j ON j.id = a.job_id
      WHERE i.scheduled_date >= CURRENT_DATE
      ORDER BY i.scheduled_date ASC, i.start_time ASC
      LIMIT 6;
    `);

    const kpi = kpiRes.rows[0];
    const passRate = kpi.assessed_count > 0
      ? Number(((kpi.passed_count / kpi.assessed_count) * 100).toFixed(1))
      : 0;

    res.json({
      kpis: { ...kpi, pass_rate: passRate },
      funnel: [
        { stage: 'إجمالي المتقدمين', count: kpi.total_applications, color: '#17191C' },
        { stage: 'مجتازو اختبار الجدارة (≥60%)', count: kpi.passed_count, color: '#E0A21B' },
        { stage: 'تم تقييمهم من اللجنة', count: kpi.evaluated_by_committee, color: '#C8553D' },
        { stage: 'المقابلات المجدولة', count: kpi.interview_stage_count, color: '#2F5D50' }
      ],
      daily_activity: dailyRes.rows,
      recent_applications: recentRes.rows,
      upcoming_interviews: todayInterviewsRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------------
// 7. تقييم لجنة التوظيف والترتيب الموزون (مع معلومات المقابلة وزر واتساب المباشر)
// ---------------------------------------------------------------------------------

app.post('/api/evaluations', requireAuth(['super_admin', 'committee_member']), async (req, res) => {
  try {
    const {
      application_id,
      evaluator_name,
      evaluator_role,
      technical_competence,
      communication_persuasion,
      problem_solving,
      cultural_fit,
      portfolio_practical,
      recommendation,
      notes,
      voice_human_note
    } = req.body;

    if (!application_id) {
      return res.status(400).json({ error: 'معرّف الطلب مفقود.' });
    }

    const appCheck = await query('SELECT id, status FROM applications WHERE id = $1', [parseInt(application_id, 10)]);
    if (!appCheck.rows.length) {
      return res.status(404).json({ error: 'الطلب غير موجود.' });
    }
    if (appCheck.rows[0].status === 'assessment_pending') {
      return res.status(400).json({
        error: 'لا يمكن رصد تقييم اللجنة لمرشح لم يُكمل اختبار الجدارة بعد.',
        code: 'APPLICATION_NOT_ASSESSED'
      });
    }

    const finalEvaluatorName = String(evaluator_name || req.user.full_name).trim();
    const finalEvaluatorRole = String(evaluator_role || req.user.job_title || 'عضو لجنة التوظيف').trim();

    const scores = [
      Number(technical_competence),
      Number(communication_persuasion),
      Number(problem_solving),
      Number(cultural_fit),
      Number(portfolio_practical)
    ];

    if (scores.some((s) => Number.isNaN(s) || s < 1 || s > 5)) {
      return res.status(400).json({ error: 'جميع المعايير الخمسة يجب أن تكون بين 1.0 و 5.0.' });
    }

    // قائمة التوصيات المسموحة مطابقة لقيد القاعدة chk المتاح في committee_evaluations.
    // أي قيمة خارجة عنها كانت تُسقط الطلب بـ 500 وتُهدر التقييم كاملاً.
    const ALLOWED_RECOMMENDATIONS = ['strong_hire', 'hire', 'hold', 'no_hire'];
    if (recommendation !== undefined && recommendation !== null && recommendation !== ''
        && !ALLOWED_RECOMMENDATIONS.includes(recommendation)) {
      return res.status(400).json({
        error: `قيمة توصية غير معروفة؛ المسموح: ${ALLOWED_RECOMMENDATIONS.join(', ')}`,
        code: 'INVALID_RECOMMENDATION',
        allowed: ALLOWED_RECOMMENDATIONS
      });
    }

    const { rows } = await query(
      `INSERT INTO committee_evaluations (
        application_id, evaluator_name, evaluator_role,
        technical_competence, communication_persuasion, problem_solving, cultural_fit, portfolio_practical,
        recommendation, notes, voice_human_note
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (application_id, evaluator_name) DO UPDATE SET
        evaluator_role = EXCLUDED.evaluator_role,
        technical_competence = EXCLUDED.technical_competence,
        communication_persuasion = EXCLUDED.communication_persuasion,
        problem_solving = EXCLUDED.problem_solving,
        cultural_fit = EXCLUDED.cultural_fit,
        portfolio_practical = EXCLUDED.portfolio_practical,
        recommendation = EXCLUDED.recommendation,
        notes = EXCLUDED.notes,
        voice_human_note = COALESCE(NULLIF(EXCLUDED.voice_human_note, ''), committee_evaluations.voice_human_note),
        evaluated_at = NOW()
      RETURNING *`,
      [
        parseInt(application_id, 10),
        finalEvaluatorName,
        finalEvaluatorRole,
        scores[0],
        scores[1],
        scores[2],
        scores[3],
        scores[4],
        recommendation || 'hire',
        notes || '',
        String(voice_human_note || '').slice(0, 1000)
      ]
    );

    await query(
      `UPDATE applications
       SET status = CASE WHEN status = 'passed_assessment' THEN 'under_review' ELSE status END
       WHERE id = $1`,
      [parseInt(application_id, 10)]
    );

    const updatedApp = await query(
      'SELECT reference_no, ai_overall_score, committee_avg_score, final_weighted_score, status FROM applications WHERE id = $1',
      [parseInt(application_id, 10)]
    );

    await logAudit({
      actor: req.user.full_name,
      actorRole: req.user.role,
      action: 'COMMITTEE_EVALUATION_SAVED',
      entityType: 'application',
      entityId: updatedApp.rows[0]?.reference_no,
      metadata: {
        eval_percentage: rows[0].total_percentage,
        final_weighted_score: updatedApp.rows[0]?.final_weighted_score,
        recommendation
      },
      ipAddress: req.ip
    });

    res.status(201).json({
      evaluation: rows[0],
      application_scores: updatedApp.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ranking', requireAuth(), async (req, res) => {
  try {
    const { job_id, passed_only } = req.query;
    const [weightsRes, locCfg] = await Promise.all([
      query("SELECT setting_value FROM system_settings WHERE setting_key = 'ranking_weights'"),
      getCompanyLocationConfig()
    ]);
    const weights = weightsRes.rows[0]?.setting_value || { ai_weight: 40, committee_weight: 60 };

    const aiWeight = req.query.ai_weight !== undefined ? Number(req.query.ai_weight) : Number(weights.ai_weight ?? 40);
    const commWeight = Number((100 - aiWeight).toFixed(2));

    const params = [];
    let filterSql = "WHERE a.status != 'assessment_pending'";
    if (passed_only === '1') {
      filterSql += " AND a.status != 'failed_assessment'";
    }
    if (job_id && job_id !== 'all') {
      params.push(parseInt(job_id, 10));
      filterSql += ` AND a.job_id = $${params.length}`;
    }

    const { rows } = await query(
      `SELECT
        a.id, a.reference_no, a.status, a.cv_match_score, a.assessment_score,
        a.ai_overall_score, a.committee_avg_score, a.final_weighted_score, a.integrity_score,
        a.voice_bonus_score,
        (a.voice_pitch_path IS NOT NULL AND (a.status = 'offered' OR a.voice_retention_expires_at IS NULL OR a.voice_retention_expires_at > NOW())) AS has_voice_pitch,
        c.full_name, c.email, c.phone, c.city, c.years_experience, c.qualification, c.specialization,
        j.id AS job_id, j.code AS job_code, j.title AS job_title, j.department, j.accent_color, j.passing_score,
        (SELECT COUNT(*)::int FROM committee_evaluations ce WHERE ce.application_id = a.id) AS evaluations_count,
        i.id AS interview_id, i.visit_token, i.scheduled_date, i.start_time, i.booking_status, i.interview_mode, i.meeting_url,
        (SELECT wm.id FROM wa_messages wm WHERE wm.interview_id = i.id ORDER BY (wm.queue_status = 'cancelled') ASC, wm.id DESC LIMIT 1) AS wa_message_id,
        (SELECT wm.queue_status FROM wa_messages wm WHERE wm.interview_id = i.id ORDER BY (wm.queue_status = 'cancelled') ASC, wm.id DESC LIMIT 1) AS wa_queue_status,
        (SELECT wm.prepared_at FROM wa_messages wm WHERE wm.interview_id = i.id ORDER BY (wm.queue_status = 'cancelled') ASC, wm.id DESC LIMIT 1) AS wa_prepared_at
      FROM applications a
      JOIN candidates c ON c.id = a.candidate_id
      JOIN jobs j ON j.id = a.job_id
      LEFT JOIN interviews i ON i.application_id = a.id
      ${filterSql}`,
      params
    );

    const origin = getBaseOrigin(req);
    const computed = rows.map((r) => {
      const ai = Number(r.ai_overall_score || 0);
      const comm = Number(r.committee_avg_score || 0);
      const dynamicScore = r.evaluations_count > 0
        ? Number(((ai * (aiWeight / 100)) + (comm * (commWeight / 100))).toFixed(2))
        : Number((ai * (aiWeight / 100)).toFixed(2));
      const passedStage1 = Number(r.assessment_score) >= Number(r.passing_score || 60);
      const { visit_token, ...safeRow } = r;
      return {
        ...safeRow,
        visit_url: r.interview_id && visit_token ? buildVisitPassUrl(origin, r.interview_id, visit_token) : null,
        passed_stage_1: passedStage1,
        computed_weighted_score: dynamicScore
      };
    }).sort((a, b) => {
      // المتأهلون للمرحلة الأولى يظهرون دائماً في الصدارة فوق غير المجتازين
      if (a.passed_stage_1 !== b.passed_stage_1) return a.passed_stage_1 ? -1 : 1;
      return b.computed_weighted_score - a.computed_weighted_score;
    });

    res.json({
      weights: { ai_weight: aiWeight, committee_weight: commWeight },
      saved_weights: weights,
      company_location: locCfg,
      ranked_candidates: computed.map((item, idx) => ({ ...item, rank: idx + 1 }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/ranking/weights', requireAuth(['super_admin']), async (req, res) => {
  try {
    const aiWeight = Math.max(0, Math.min(100, Number(req.body.ai_weight ?? 40)));
    const committeeWeight = Number((100 - aiWeight).toFixed(2));

    await query(
      `UPDATE system_settings
       SET setting_value = $1::jsonb, updated_by = $2, updated_at = NOW()
       WHERE setting_key = 'ranking_weights'`,
      [JSON.stringify({ ai_weight: aiWeight, committee_weight: committeeWeight, passing_threshold: 60 }), req.user.full_name]
    );

    await query('SELECT fn_sync_application_weighted_score(id) FROM applications');

    await logAudit({
      actor: req.user.full_name,
      actorRole: req.user.role,
      action: 'RANKING_WEIGHTS_UPDATED',
      entityType: 'system_settings',
      entityId: 'ranking_weights',
      metadata: { ai_weight: aiWeight, committee_weight: committeeWeight },
      ipAddress: req.ip
    });

    res.json({ message: 'تم اعتماد الأوزان الجديدة وإعادة حساب ترتيب كافة المرشحين.', ai_weight: aiWeight, committee_weight: committeeWeight });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------------
// 8. جدولة المقابلات (الفردية السريعة من الترتيب + الجماعية الذكية — عن بُعد وحضوري)
// ---------------------------------------------------------------------------------

app.get('/api/interviews', requireAuth(), async (req, res) => {
  try {
    const { date } = req.query;
    const params = [];
    let whereSql = '';
    if (date) {
      params.push(date);
      whereSql = 'WHERE i.scheduled_date = $1';
    }

    const [intRes, eligibleRes, locCfg] = await Promise.all([
      query(
        `SELECT
          i.*,
          a.reference_no, a.final_weighted_score, a.ai_overall_score, a.committee_avg_score, a.status AS app_status,
          c.full_name, c.phone, c.email, c.city,
          j.code AS job_code, j.title AS job_title, j.department, j.accent_color,
          (SELECT wm.id FROM wa_messages wm WHERE wm.interview_id = i.id ORDER BY (wm.queue_status = 'cancelled') ASC, wm.id DESC LIMIT 1) AS wa_message_id,
          (SELECT wm.queue_status FROM wa_messages wm WHERE wm.interview_id = i.id ORDER BY (wm.queue_status = 'cancelled') ASC, wm.id DESC LIMIT 1) AS wa_status,
          (SELECT wm.wa_link FROM wa_messages wm WHERE wm.interview_id = i.id ORDER BY (wm.queue_status = 'cancelled') ASC, wm.id DESC LIMIT 1) AS wa_link
        FROM interviews i
        JOIN applications a ON a.id = i.application_id
        JOIN candidates c ON c.id = a.candidate_id
        JOIN jobs j ON j.id = a.job_id
        ${whereSql}
        ORDER BY i.scheduled_date ASC, i.start_time ASC`,
        params
      ),
      query(`
        SELECT
          a.id AS application_id, a.reference_no, a.final_weighted_score, a.ai_overall_score, a.assessment_score,
          c.full_name, c.phone,
          j.code AS job_code, j.title AS job_title
        FROM applications a
        JOIN candidates c ON c.id = a.candidate_id
        JOIN jobs j ON j.id = a.job_id
        LEFT JOIN interviews i ON i.application_id = a.id
        WHERE i.id IS NULL
          AND a.status IN ('passed_assessment', 'under_review')
        ORDER BY a.final_weighted_score DESC, a.ai_overall_score DESC;
      `),
      getCompanyLocationConfig()
    ]);

    const origin = getBaseOrigin(req);
    const interviewsWithVisitUrl = intRes.rows.map(({ visit_token, ...row }) => ({
      ...row,
      visit_url: buildVisitPassUrl(origin, row.id, visit_token),
      // v2.4: رابط غرفة Jitsi للجنة (بلا كشف أي سر) — يبقى meeting_url كبديل احتياطي
      jitsi_room_url: row.interview_mode === 'in_person' || !row.jitsi_room_name
        ? null
        : jitsiClient.buildRoomSession({
            roomName: row.jitsi_room_name,
            // صلاحية الغرفة تتبع دور الطالب لا الصفحة: المنسق participant فقط،
            // واللجنة/الإدارة moderator. لا يجوز منح توكن إدارة من مسار قائمة عام.
            role: ['super_admin', 'committee_member'].includes(req.user.role) ? 'moderator' : 'participant',
            displayName: req.user.full_name || 'لجنة التوظيف'
          }).join_url
    }));

    res.json({
      interviews: interviewsWithVisitUrl,
      unscheduled_qualified: eligibleRes.rows,
      company_location: locCfg
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// جدولة سريعة لمرشح واحد مباشرة من صفحة الترتيب (عن بُعد أو حضوري) وتوليد رسالة واتساب فورية
app.post('/api/interviews/schedule-single', requireAuth(['super_admin', 'hr_coordinator']), async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      application_id,
      scheduled_date,
      start_time = '10:00',
      duration_minutes = 30,
      interview_mode = 'remote',
      meeting_url,
      location_building,
      location_floor,
      location_office,
      location_maps_url,
      location_image_url,
      location_notes,
      interviewer_panel = 'لجنة التوظيف والاختيار المركزية',
      open_draft = false
    } = req.body || {};

    if (!application_id || !scheduled_date || !start_time) {
      return res.status(400).json({ error: 'يرجى تحديد المرشح وتاريخ ووقت المقابلة.' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(scheduled_date).trim()) || !isValidTimeHHMM(start_time)) {
      return res.status(400).json({ error: 'صيغة تاريخ أو وقت المقابلة غير صالحة.', code: 'INVALID_INTERVIEW_SLOT' });
    }
    if (interview_mode !== undefined && !['remote', 'in_person'].includes(interview_mode)) {
      return res.status(400).json({ error: 'نمط المقابلة يجب أن يكون remote أو in_person.' });
    }

    const dur = Math.max(15, Math.min(240, parseInt(duration_minutes, 10) || 30));
    const startMin = timeToMinutes(start_time);
    if (startMin + dur >= 24 * 60) {
      return res.status(400).json({ error: 'وقت نهاية المقابلة يتجاوز نهاية اليوم.', code: 'INVALID_INTERVIEW_SLOT' });
    }
    const endStr = minutesToTime(startMin + dur);

    const [locCfg, tplRes] = await Promise.all([
      getCompanyLocationConfig(),
      client.query("SELECT setting_value FROM system_settings WHERE setting_key = 'whatsapp_templates'")
    ]);
    const templates = tplRes.rows[0]?.setting_value || {};

    await client.query('BEGIN');

    // قفل صف الطلب أولاً لمنع السباق المتزامن في جدولة نفس المرشح والتحقق الصارم من أهليته للمقابلة
    const candRes = await client.query(
      `SELECT a.id AS application_id, a.reference_no, a.status,
              c.full_name, c.phone, j.code AS job_code, j.title AS job_title
       FROM applications a
       JOIN candidates c ON c.id = a.candidate_id
       JOIN jobs j ON j.id = a.job_id
       WHERE a.id = $1
       FOR UPDATE OF a`,
      [parseInt(application_id, 10)]
    );
    if (!candRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'المرشح المطلوب غير موجود.' });
    }
    const cand = candRes.rows[0];

    const eligibleStatuses = ['passed_assessment', 'under_review', 'interview_scheduled', 'interviewed'];
    if (!eligibleStatuses.includes(cand.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'لا يمكن جدولة مقابلة لمرشح غير متأهل أو لم يُكمل الاختبار أو تم الاعتذار له.',
        code: 'APPLICATION_NOT_ELIGIBLE_FOR_INTERVIEW'
      });
    }

    const prevIntRes = await client.query(
      'SELECT id, booking_status FROM interviews WHERE application_id = $1 FOR UPDATE',
      [cand.application_id]
    );
    if (prevIntRes.rows.length > 0 && prevIntRes.rows[0].booking_status === 'completed') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'تمت هذه المقابلة بالفعل ولا يمكن إعادة جدولتها فوق سجل مكتمل.',
        code: 'INTERVIEW_ALREADY_COMPLETED'
      });
    }

    const origin = getBaseOrigin(req);
    const isRemote = interview_mode !== 'in_person';
    // v2.4: غرفة Jitsi خاصة عشوائية غير قابلة للتخمين لكل مقابلة عن بُعد (تُثبَّت مرة واحدة لكل موعد)
    const jitsiEnv = jitsiClient.getJitsiEnvConfig();
    const scheduledRoomName = isRemote && jitsiEnv.enabled ? jitsiClient.generateRoomName() : null;
    const defaultRoom = scheduledRoomName
      ? jitsiClient.buildRoomUrl(jitsiEnv.domain, scheduledRoomName)
      : `https://meet.jit.si/JPF-${cand.job_code.replace(/[^a-zA-Z0-9]/g, '')}-${cand.reference_no.slice(-4)}`;
    const provisionalMeetUrl = isRemote ? (meeting_url && String(meeting_url).trim() ? String(meeting_url).trim() : defaultRoom) : origin;

    const finalBuilding = location_building || locCfg.building_name;
    const finalFloor = location_floor || locCfg.floor_number;
    const finalOffice = location_office || locCfg.office_number;
    const finalMaps = location_maps_url || locCfg.google_maps_url;
    const finalImg = location_image_url || locCfg.entrance_image_url || '/img/hq-entrance.svg';
    const finalNotes = location_notes || locCfg.arrival_instructions;

    const isReschedule = prevIntRes.rows.length > 0;
    const freshVisitToken = crypto.randomBytes(32).toString('hex');

    if (isReschedule) {
      // إبطال كافة الدعوات والرسائل السابقة غير الملغاة المرتبطة بالموعد القديم قبل إصدار الدعوة الجديدة برمز زيارة جديد
      await client.query(
        `UPDATE wa_messages
         SET queue_status = 'cancelled'
         WHERE interview_id = $1 AND queue_status <> 'cancelled'`,
        [prevIntRes.rows[0].id]
      );
    }

    // لا يُسجَّل الموعد كـ invitation_sent لمجرد فتح رابط wa.me؛ يبقى scheduled / rescheduled حتى يؤكد الموظف الإرسال الفعلي
    const intIns = await client.query(
      `INSERT INTO interviews (
        application_id, scheduled_date, start_time, end_time, duration_minutes,
        meeting_platform, meeting_url, interviewer_panel, booking_status,
        interview_mode, visit_token, location_building, location_floor, location_office,
        location_maps_url, location_image_url, location_notes, notes, jitsi_room_name
      ) VALUES ($1,$2::date,$3::time,$4::time,$5,$6,$7,$8,'scheduled',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (application_id) DO UPDATE SET
        scheduled_date = EXCLUDED.scheduled_date,
        start_time = EXCLUDED.start_time,
        end_time = EXCLUDED.end_time,
        duration_minutes = EXCLUDED.duration_minutes,
        meeting_platform = EXCLUDED.meeting_platform,
        meeting_url = EXCLUDED.meeting_url,
        interviewer_panel = EXCLUDED.interviewer_panel,
        interview_mode = EXCLUDED.interview_mode,
        visit_token = EXCLUDED.visit_token,
        location_building = EXCLUDED.location_building,
        location_floor = EXCLUDED.location_floor,
        location_office = EXCLUDED.location_office,
        location_maps_url = EXCLUDED.location_maps_url,
        location_image_url = EXCLUDED.location_image_url,
        location_notes = EXCLUDED.location_notes,
        booking_status = 'rescheduled',
        lobby_status = 'not_arrived',
        checked_in_at = NULL,
        checked_in_by = NULL,
        punctuality_minutes = NULL,
        jitsi_room_name = COALESCE(interviews.jitsi_room_name, EXCLUDED.jitsi_room_name),
        updated_at = NOW()
      RETURNING *`,
      [
        cand.application_id,
        scheduled_date,
        start_time,
        endStr,
        dur,
        isRemote ? 'قاعة افتراضية (أونلاين)' : 'مقابلة حضورية في المقر',
        provisionalMeetUrl,
        interviewer_panel,
        isRemote ? 'remote' : 'in_person',
        freshVisitToken,
        finalBuilding,
        finalFloor,
        finalOffice,
        finalMaps,
        finalImg,
        finalNotes,
        isRemote ? 'مقابلة عن بُعد' : `حضوري: ${finalFloor} - ${finalOffice}`,
        scheduledRoomName
      ]
    );

    const savedInt = intIns.rows[0];
    const visitUrl = buildVisitPassUrl(origin, savedInt.id, savedInt.visit_token);
    const finalMeetUrl = isRemote ? provisionalMeetUrl : visitUrl;

    if (!isRemote) {
      await client.query('UPDATE interviews SET meeting_url = $1 WHERE id = $2', [visitUrl, savedInt.id]);
      savedInt.meeting_url = visitUrl;
    }

    await client.query(
      "UPDATE applications SET status = 'interview_scheduled', updated_at = NOW() WHERE id = $1",
      [cand.application_id]
    );

    const tplKey = isRemote ? 'interview_invite' : 'interview_inperson';
    const rawTpl = templates[tplKey] || (isRemote
      ? 'مرحباً {الاسم}،\nيسعدنا دعوتك لمقابلة وظيفة ({الوظيفة}) عن بُعد.\n📅 الموعد: {موعد_المقابلة}\n🎥 رابط القاعة وتأكيد الحضور:\n{رابط_الحجز}'
      : 'مرحباً {الاسم}،\nيسعدنا دعوتك لمقابلة حضورية لوظيفة ({الوظيفة}).\n📅 الموعد: {موعد_المقابلة}\n🏢 الموقع: {المقر} — {الدور} — {المكتب}\n📍 بطاقة الوصول وصورة المدخل وخريطة قوقل:\n{بطاقة_الموقع}');

    const msgBody = renderWhatsAppTemplate(rawTpl, {
      name: cand.full_name,
      job_title: cand.job_title,
      job_code: cand.job_code,
      reference_no: cand.reference_no,
      date: scheduled_date,
      time: start_time,
      meet_url: finalMeetUrl,
      visit_url: visitUrl,
      building: finalBuilding,
      floor: finalFloor,
      office: finalOffice,
      maps_url: finalMaps
    });

    const waLink = buildWaLink(cand.phone, msgBody);

    // تبقى الرسالة في حالة queued («جاهزة للإرسال» أو «فُتحت كمسودة») ولا تتحول إلى sent إلا بتأكيد الإرسال الفعلي
    const waIns = await client.query(
      `INSERT INTO wa_messages (
        application_id, interview_id, template_key, recipient_name, recipient_phone,
        message_body, wa_link, queue_status, prepared_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued', CASE WHEN $8::boolean THEN NOW() ELSE NULL END)
      RETURNING *`,
      [
        cand.application_id,
        savedInt.id,
        tplKey,
        cand.full_name,
        normalizePhoneForWa(cand.phone),
        msgBody,
        waLink,
        Boolean(open_draft)
      ]
    );

    await client.query('COMMIT');

    await logAudit({
      actor: req.user.full_name,
      actorRole: req.user.role,
      action: 'SINGLE_INTERVIEW_SCHEDULED',
      entityType: 'interview',
      entityId: cand.reference_no,
      metadata: { mode: isRemote ? 'remote' : 'in_person', date: scheduled_date, time: start_time, draft_opened: Boolean(open_draft) },
      ipAddress: req.ip
    });

    const { visit_token: _vt, ...safeInterview } = savedInt;
    res.status(201).json({
      message: 'تم اعتماد الموعد وتجهيز مسودة رسالة واتساب (يرجى تأكيد الإرسال بعد ضغط زر الإرسال في واتساب).',
      interview: safeInterview,
      wa_message: waIns.rows[0],
      wa_link: waLink,
      visit_url: visitUrl
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/interviews/auto-schedule', requireAuth(['super_admin', 'hr_coordinator']), async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      target_date,
      work_start = '09:00',
      work_end = '16:00',
      slot_duration_minutes = 30,
      buffer_minutes = 10,
      exclude_dhuhr = true,
      dhuhr_start = '12:00',
      dhuhr_end = '12:45',
      interview_mode = 'remote',
      interviewer_panel = 'لجنة التوظيف والاختيار المركزية',
      application_ids
    } = req.body;

    const scheduleDate = target_date || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(scheduleDate).trim()) || !isValidTimeHHMM(work_start) || !isValidTimeHHMM(work_end)) {
      return res.status(400).json({ error: 'صيغة تاريخ أو أوقات الدوام غير صالحة.', code: 'INVALID_INTERVIEW_SLOT' });
    }
    const dayStart = timeToMinutes(work_start);
    const dayEnd = timeToMinutes(work_end);
    if (dayEnd <= dayStart) {
      return res.status(400).json({ error: 'وقت نهاية الدوام يجب أن يكون بعد وقت البداية.', code: 'INVALID_INTERVIEW_SLOT' });
    }

    const duration = Math.max(15, Math.min(240, parseInt(slot_duration_minutes, 10) || 30));
    const buffer = Math.max(0, parseInt(buffer_minutes, 10) || 10);
    const isRemote = interview_mode !== 'in_person';
    const origin = getBaseOrigin(req);
    const locCfg = await getCompanyLocationConfig();
    const tplRes = await client.query("SELECT setting_value FROM system_settings WHERE setting_key = 'whatsapp_templates'");
    const templates = tplRes.rows[0]?.setting_value || {};
    const tplKey = isRemote ? 'interview_invite' : 'interview_inperson';
    const inviteTemplate = templates[tplKey] || 'مرحباً {الاسم}، يسعدنا دعوتك لمقابلة ({الوظيفة}) بتاريخ {موعد_المقابلة}. التفاصيل وتأكيد الحضور: {رابط_الحجز}';

    await client.query('BEGIN');

    let candidatesQuery = `
      SELECT a.id AS application_id, a.reference_no, a.status, c.full_name, c.phone, j.code AS job_code, j.title AS job_title
      FROM applications a
      JOIN candidates c ON c.id = a.candidate_id
      JOIN jobs j ON j.id = a.job_id
      LEFT JOIN interviews i ON i.application_id = a.id
      WHERE i.id IS NULL AND a.status IN ('passed_assessment', 'under_review')
    `;
    const params = [];
    if (Array.isArray(application_ids) && application_ids.length > 0) {
      params.push(application_ids.map((x) => parseInt(x, 10)));
      candidatesQuery = `
        SELECT a.id AS application_id, a.reference_no, a.status, c.full_name, c.phone, j.code AS job_code, j.title AS job_title
        FROM applications a
        JOIN candidates c ON c.id = a.candidate_id
        JOIN jobs j ON j.id = a.job_id
        LEFT JOIN interviews i ON i.application_id = a.id
        WHERE a.id = ANY($1::int[])
          AND a.status IN ('passed_assessment', 'under_review', 'interview_scheduled')
          AND (i.id IS NULL OR i.booking_status <> 'completed')
      `;
    }
    candidatesQuery += ' ORDER BY a.final_weighted_score DESC, a.ai_overall_score DESC FOR UPDATE OF a';

    const candRes = await client.query(candidatesQuery, params);
    if (!candRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'لا يوجد مرشحون مؤهلون غير مكتملين حالياً لتوزيع المواعيد عليهم.' });
    }

    const bookedRes = await client.query(
      "SELECT start_time, end_time FROM interviews WHERE scheduled_date = $1 AND booking_status <> 'cancelled' FOR UPDATE",
      [scheduleDate]
    );
    const bookedRanges = bookedRes.rows.map((b) => [
      timeToMinutes(String(b.start_time).slice(0, 5)),
      timeToMinutes(String(b.end_time).slice(0, 5))
    ]);

    const prayerStart = timeToMinutes(dhuhr_start);
    const prayerEnd = timeToMinutes(dhuhr_end);

    let cursor = dayStart;
    const scheduled = [];

    for (const cand of candRes.rows) {
      let slotFound = false;
      while (cursor + duration <= dayEnd) {
        const slotStart = cursor;
        const slotEnd = cursor + duration;

        if (exclude_dhuhr && slotStart < prayerEnd && slotEnd > prayerStart) {
          cursor = prayerEnd;
          continue;
        }

        const conflict = bookedRanges.some(([bStart, bEnd]) => slotStart < bEnd && slotEnd > bStart);
        if (conflict) {
          cursor += 15;
          continue;
        }

        const startStr = minutesToTime(slotStart);
        const endStr = minutesToTime(slotEnd);
        const provisionalMeetUrl = isRemote
          ? `https://meet.jit.si/JPF-${cand.job_code.replace(/[^a-zA-Z0-9]/g, '')}-${cand.reference_no.slice(-4)}`
          : origin;

        const freshAutoToken = crypto.randomBytes(32).toString('hex');
        const prevAutoInt = await client.query('SELECT id FROM interviews WHERE application_id = $1 FOR UPDATE', [cand.application_id]);
        if (prevAutoInt.rows.length > 0) {
          await client.query(
            `UPDATE wa_messages
             SET queue_status = 'cancelled'
             WHERE interview_id = $1 AND queue_status <> 'cancelled'`,
            [prevAutoInt.rows[0].id]
          );
        }

        const intIns = await client.query(
          `INSERT INTO interviews (
            application_id, scheduled_date, start_time, end_time, duration_minutes,
            meeting_platform, meeting_url, interviewer_panel, booking_status,
            interview_mode, visit_token, location_building, location_floor, location_office,
            location_maps_url, location_image_url, location_notes, notes
          ) VALUES ($1,$2,$3::time,$4::time,$5,$6,$7,$8,'scheduled',$9,$10,$11,$12,$13,$14,$15,$16,'جدولة تلقائية ذكية')
          ON CONFLICT (application_id) DO UPDATE SET
            scheduled_date = EXCLUDED.scheduled_date,
            start_time = EXCLUDED.start_time,
            end_time = EXCLUDED.end_time,
            duration_minutes = EXCLUDED.duration_minutes,
            meeting_platform = EXCLUDED.meeting_platform,
            meeting_url = EXCLUDED.meeting_url,
            interviewer_panel = EXCLUDED.interviewer_panel,
            interview_mode = EXCLUDED.interview_mode,
            visit_token = EXCLUDED.visit_token,
            location_building = EXCLUDED.location_building,
            location_floor = EXCLUDED.location_floor,
            location_office = EXCLUDED.location_office,
            location_maps_url = EXCLUDED.location_maps_url,
            location_image_url = EXCLUDED.location_image_url,
            location_notes = EXCLUDED.location_notes,
            booking_status = 'rescheduled',
            lobby_status = 'not_arrived',
            checked_in_at = NULL,
            checked_in_by = NULL,
            punctuality_minutes = NULL,
            updated_at = NOW()
          RETURNING *`,
          [
            cand.application_id,
            scheduleDate,
            startStr,
            endStr,
            duration,
            isRemote ? 'قاعة افتراضية (أونلاين)' : 'مقابلة حضورية في المقر',
            provisionalMeetUrl,
            interviewer_panel,
            isRemote ? 'remote' : 'in_person',
            freshAutoToken,
            locCfg.building_name,
            locCfg.floor_number,
            locCfg.office_number,
            locCfg.google_maps_url,
            locCfg.entrance_image_url || '/img/hq-entrance.svg',
            locCfg.arrival_instructions
          ]
        );

        const savedAutoInt = intIns.rows[0];
        const visitUrl = buildVisitPassUrl(origin, savedAutoInt.id, savedAutoInt.visit_token);
        const meetUrl = isRemote ? provisionalMeetUrl : visitUrl;
        if (!isRemote) {
          await client.query('UPDATE interviews SET meeting_url = $1 WHERE id = $2', [visitUrl, savedAutoInt.id]);
          savedAutoInt.meeting_url = visitUrl;
        }

        await client.query(
          "UPDATE applications SET status = 'interview_scheduled', updated_at = NOW() WHERE id = $1",
          [cand.application_id]
        );

        const msgBody = renderWhatsAppTemplate(inviteTemplate, {
          name: cand.full_name,
          job_title: cand.job_title,
          job_code: cand.job_code,
          reference_no: cand.reference_no,
          date: scheduleDate,
          time: startStr,
          meet_url: meetUrl,
          visit_url: visitUrl,
          building: locCfg.building_name,
          floor: locCfg.floor_number,
          office: locCfg.office_number,
          maps_url: locCfg.google_maps_url
        });

        const waLink = buildWaLink(cand.phone, msgBody);

        await client.query(
          `INSERT INTO wa_messages (
            application_id, interview_id, template_key, recipient_name, recipient_phone,
            message_body, wa_link, queue_status
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued')`,
          [cand.application_id, intIns.rows[0].id, tplKey, cand.full_name, normalizePhoneForWa(cand.phone), msgBody, waLink]
        );

        const { visit_token: _vtAuto, ...safeAutoInt } = savedAutoInt;
        bookedRanges.push([slotStart, slotEnd]);
        scheduled.push({
          ...safeAutoInt,
          full_name: cand.full_name,
          job_code: cand.job_code,
          job_title: cand.job_title,
          wa_link: waLink,
          visit_url: visitUrl
        });

        cursor = slotEnd + buffer;
        slotFound = true;
        break;
      }

      if (!slotFound) break;
    }

    await client.query('COMMIT');

    await logAudit({
      actor: req.user.full_name,
      actorRole: req.user.role,
      action: 'AUTO_SCHEDULE_EXECUTED',
      entityType: 'interviews',
      entityId: scheduleDate,
      metadata: { scheduled_count: scheduled.length, mode: interview_mode, exclude_dhuhr },
      ipAddress: req.ip
    });

    res.status(201).json({
      message: `تمت جدولة ${scheduled.length} مقابلة (${isRemote ? 'عن بُعد' : 'حضورية'}) وتجهيز طابور رسائل واتساب بنجاح.`,
      scheduled
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.patch('/api/interviews/:id', requireAuth(['super_admin', 'hr_coordinator', 'committee_member']), async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    const { booking_status, notes, scheduled_date, start_time, end_time, interview_mode } = req.body || {};

    const validInterviewStatuses = ['scheduled', 'rescheduled', 'invitation_sent', 'confirmed', 'completed', 'no_show', 'cancelled'];
    if (booking_status !== undefined && !validInterviewStatuses.includes(booking_status)) {
      return res.status(400).json({ error: 'حالة الموعد غير صالحة.', code: 'INVALID_INTERVIEW_STATUS' });
    }
    if (scheduled_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(scheduled_date).trim())) {
      return res.status(400).json({ error: 'صيغة تاريخ المقابلة غير صالحة.', code: 'INVALID_INTERVIEW_SLOT' });
    }
    if (start_time !== undefined && !isValidTimeHHMM(start_time)) {
      return res.status(400).json({ error: 'صيغة وقت البداية غير صالحة.', code: 'INVALID_INTERVIEW_SLOT' });
    }
    if (end_time !== undefined && !isValidTimeHHMM(end_time)) {
      return res.status(400).json({ error: 'صيغة وقت النهاية غير صالحة.', code: 'INVALID_INTERVIEW_SLOT' });
    }
    if (interview_mode !== undefined && !['remote', 'in_person'].includes(interview_mode)) {
      return res.status(400).json({ error: 'نمط المقابلة غير صالح.', code: 'INVALID_INTERVIEW_MODE' });
    }

    await client.query('BEGIN');
    const curRes = await client.query(
      `SELECT i.*, a.reference_no, c.full_name, c.phone, j.code AS job_code, j.title AS job_title
       FROM interviews i
       JOIN applications a ON a.id = i.application_id
       JOIN candidates c ON c.id = a.candidate_id
       JOIN jobs j ON j.id = a.job_id
       WHERE i.id = $1
       FOR UPDATE OF i`,
      [id]
    );
    if (!curRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الموعد غير موجود.' });
    }

    const cur = curRes.rows[0];
    const curDateStr = cur.scheduled_date instanceof Date
      ? cur.scheduled_date.toISOString().slice(0, 10)
      : String(cur.scheduled_date || '').slice(0, 10);
    const curStartStr = String(cur.start_time || '').slice(0, 5);
    const curEndStr = String(cur.end_time || '').slice(0, 5);

    const slotOrModeChanged =
      (scheduled_date && String(scheduled_date).slice(0, 10) !== curDateStr) ||
      (start_time && String(start_time).slice(0, 5) !== curStartStr) ||
      (end_time && String(end_time).slice(0, 5) !== curEndStr) ||
      (interview_mode && interview_mode !== cur.interview_mode);

    const scheduleChanged = slotOrModeChanged || booking_status === 'rescheduled';
    const isCancelled = booking_status === 'cancelled';

    // صلاحية عضو اللجنة (committee_member): يقتصر دوره على رصد إتمام المقابلة أو عدم الحضور والملاحظات دون إعادة الجدولة أو الإلغاء
    if (req.user.role === 'committee_member') {
      if (scheduleChanged || isCancelled || (booking_status !== undefined && !['completed', 'no_show'].includes(booking_status))) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: 'صلاحية عضو اللجنة تقتصر على رصد حضور وإتمام المقابلة والملاحظات؛ إعادة الجدولة والإلغاء من اختصاص الموارد البشرية.',
          code: 'FORBIDDEN_ROLE'
        });
      }
    }

    // لا يُسمح بإعادة جدولة أو إلغاء مقابلة مكتملة فعلياً (completed)
    if (cur.booking_status === 'completed' && (scheduleChanged || isCancelled || (booking_status && booking_status !== 'completed'))) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'تمت هذه المقابلة بالفعل وتوثيقها كمكتملة؛ لا يمكن إلغاؤها أو إعادة جدولتها.',
        code: 'INTERVIEW_ALREADY_COMPLETED'
      });
    }

    // إذا كان الموعد ملغى وطلب إعادة جدولة دون إرسال تاريخ أو وقت جديد، يُرفض الطلب
    if (cur.booking_status === 'cancelled' && scheduleChanged && !slotOrModeChanged && !scheduled_date && !start_time) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'لإعادة جدولة موعد ملغى، يرجى تحديد التاريخ والوقت الجديدين للمقابلة.',
        code: 'INVALID_INTERVIEW_TRANSITION'
      });
    }

    // منع تعيين invitation_sent أو confirmed أو الرجوع إلى scheduled أو القفز قبل الدعوة
    if (booking_status && booking_status !== cur.booking_status && !scheduleChanged) {
      if (booking_status === 'scheduled') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'لا يمكن إرجاع حالة الموعد إلى (مجدولة مبدئياً) بعد تقدم حالتها؛ استخدم إعادة الجدولة لتحديد موعد جديد.',
          code: 'INVALID_INTERVIEW_TRANSITION'
        });
      }
      if (booking_status === 'invitation_sent') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'لا يمكن تعيين حالة (أُرسلت الدعوة) مباشرةً من تعديل الموعد؛ تتحول الحالة تلقائياً بعد تأكيد إرسال الدعوة من طابور واتساب.',
          code: 'INVALID_INTERVIEW_TRANSITION'
        });
      }
      if (booking_status === 'confirmed') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'لا يمكن تعيين حالة (مؤكدة الحضور) مباشرةً من تعديل الموعد؛ يتم التأكيد عبر رابط الزيارة الموقّع أو تأكيد الرد على رسالة مرسلة.',
          code: 'INVALID_INTERVIEW_TRANSITION'
        });
      }
      if (['completed', 'no_show'].includes(booking_status) && !['invitation_sent', 'confirmed', 'completed', 'no_show'].includes(cur.booking_status)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'لا يمكن تسجيل إتمام المقابلة أو عدم الحضور قبل إرسال الدعوة الرسمية للمرشح.',
          code: 'INVALID_INTERVIEW_TRANSITION'
        });
      }
      if (cur.booking_status === 'cancelled' && booking_status !== 'cancelled') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'لا يمكن إعادة تفعيل موعد ملغى دون تحديد تاريخ أو وقت جديد لإعادة الجدولة وإصدار رمز زيارة جديد.',
          code: 'INVALID_INTERVIEW_TRANSITION'
        });
      }
    }

    const effectiveStartStr = start_time ? String(start_time).slice(0, 5) : curStartStr;
    let effectiveEndTime = end_time ? String(end_time).slice(0, 5) : null;
    if (!effectiveEndTime && start_time) {
      const nextEndMin = timeToMinutes(effectiveStartStr) + (Number(cur.duration_minutes) || 30);
      if (nextEndMin >= 24 * 60) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'وقت نهاية المقابلة يتجاوز نهاية اليوم.', code: 'INVALID_INTERVIEW_SLOT' });
      }
      effectiveEndTime = minutesToTime(nextEndMin);
    }
    const checkEndStr = effectiveEndTime || curEndStr;
    if (timeToMinutes(checkEndStr) <= timeToMinutes(effectiveStartStr)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'وقت نهاية المقابلة يجب أن يكون بعد وقت البداية.', code: 'INVALID_INTERVIEW_SLOT' });
    }

    const shouldRevokePriorPass = (scheduleChanged && !isCancelled) || (isCancelled && cur.booking_status !== 'cancelled');
    const nextVisitToken = shouldRevokePriorPass ? crypto.randomBytes(32).toString('hex') : cur.visit_token;
    const effectiveStatus = isCancelled
      ? 'cancelled'
      : scheduleChanged
        ? 'rescheduled'
        : (booking_status || cur.booking_status);

    const origin = getBaseOrigin(req);
    const nextMode = interview_mode || cur.interview_mode || 'remote';
    const newVisitUrl = buildVisitPassUrl(origin, id, nextVisitToken);
    const nextMeetingUrl = nextMode === 'in_person' ? newVisitUrl : cur.meeting_url;

    const { rows } = await client.query(
      `UPDATE interviews SET
        booking_status = $1::varchar,
        notes = COALESCE($2, notes),
        scheduled_date = COALESCE($3::date, scheduled_date),
        start_time = COALESCE($4::time, start_time),
        end_time = COALESCE($5::time, end_time),
        interview_mode = $6,
        visit_token = $7,
        meeting_url = $8,
        lobby_status = CASE
          WHEN $1::varchar = 'completed' THEN 'completed'
          WHEN $1::varchar IN ('cancelled', 'no_show') OR $10::boolean THEN 'not_arrived'
          ELSE lobby_status
        END,
        checked_in_at = CASE WHEN $1::varchar IN ('cancelled', 'no_show') OR $10::boolean THEN NULL ELSE checked_in_at END,
        checked_in_by = CASE WHEN $1::varchar IN ('cancelled', 'no_show') OR $10::boolean THEN NULL ELSE checked_in_by END,
        punctuality_minutes = CASE WHEN $1::varchar IN ('cancelled', 'no_show') OR $10::boolean THEN NULL ELSE punctuality_minutes END,
        updated_at = NOW()
      WHERE id = $9
      RETURNING *`,
      [
        effectiveStatus,
        notes || null,
        scheduled_date || null,
        start_time || null,
        effectiveEndTime,
        nextMode,
        nextVisitToken,
        nextMeetingUrl,
        id,
        Boolean(shouldRevokePriorPass)
      ]
    );

    let replacementWaMessage = null;
    if (shouldRevokePriorPass) {
      // إبطال كافة الدعوات والرسائل السابقة المرتبطة بالموعد القديم أو الملغى
      await client.query(
        `UPDATE wa_messages
         SET queue_status = 'cancelled'
         WHERE interview_id = $1 AND queue_status <> 'cancelled'`,
        [id]
      );

      if (scheduleChanged && !isCancelled) {
        const [tplRes, locCfg] = await Promise.all([
          client.query("SELECT setting_value FROM system_settings WHERE setting_key = 'whatsapp_templates'"),
          getCompanyLocationConfig()
        ]);
        const templates = tplRes.rows[0]?.setting_value || {};
        const rawTpl = templates.reschedule_notice ||
          'مرحباً {الاسم}، تم تحديث موعد مقابلة ({الوظيفة}) إلى {موعد_المقابلة}. رابط البطاقة المحدّث وتأكيد الحضور:\n{بطاقة_الموقع}';
        const updatedInt = rows[0];
        const newDateStr = updatedInt.scheduled_date instanceof Date
          ? updatedInt.scheduled_date.toISOString().slice(0, 10)
          : String(updatedInt.scheduled_date).slice(0, 10);
        const newStartStr = String(updatedInt.start_time).slice(0, 5);
        const msgBody = renderWhatsAppTemplate(rawTpl, {
          name: cur.full_name,
          job_title: cur.job_title,
          job_code: cur.job_code,
          reference_no: cur.reference_no,
          date: newDateStr,
          time: newStartStr,
          meet_url: nextMeetingUrl,
          visit_url: newVisitUrl,
          building: updatedInt.location_building || locCfg.building_name,
          floor: updatedInt.location_floor || locCfg.floor_number,
          office: updatedInt.location_office || locCfg.office_number,
          maps_url: updatedInt.location_maps_url || locCfg.google_maps_url
        });
        const waLink = buildWaLink(cur.phone, msgBody);
        const waIns = await client.query(
          `INSERT INTO wa_messages (
            application_id, interview_id, template_key, recipient_name, recipient_phone,
            message_body, wa_link, queue_status
          ) VALUES ($1,$2,'reschedule_notice',$3,$4,$5,$6,'queued')
          RETURNING *`,
          [cur.application_id, id, cur.full_name, normalizePhoneForWa(cur.phone), msgBody, waLink]
        );
        replacementWaMessage = waIns.rows[0];
      }
    }

    if (effectiveStatus === 'completed') {
      await client.query("UPDATE applications SET status = 'interviewed', updated_at = NOW() WHERE id = $1", [rows[0].application_id]);
    }

    await client.query('COMMIT');

    const { visit_token: _vtPatch, ...safePatchInt } = rows[0];
    res.json({
      interview: { ...safePatchInt, visit_url: newVisitUrl },
      wa_message: replacementWaMessage,
      visit_url: newVisitUrl
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------------
// 9. طابور رسائل واتساب الهجين وقوالب المراحل الخمس
// ---------------------------------------------------------------------------------

app.get('/api/wa-messages', requireAuth(), async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    const conditions = [];

    // حصر قراءة رسائل ومفاتيح استعادة المتقدمين (portal_recovery) بالمدير ومنسق الموارد البشرية فقط
    const canReadRecoverySecrets = ['super_admin', 'hr_coordinator'].includes(req.user.role);
    if (!canReadRecoverySecrets) {
      conditions.push("wm.template_key <> 'portal_recovery'");
    }

    if (status === 'ready') {
      conditions.push("wm.queue_status = 'queued' AND wm.prepared_at IS NULL");
    } else if (status === 'draft_opened') {
      conditions.push("wm.queue_status = 'queued' AND wm.prepared_at IS NOT NULL");
    } else if (status && status !== 'all') {
      params.push(status);
      conditions.push(`wm.queue_status = $${params.length}`);
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [msgRes, tplRes, locCfg] = await Promise.all([
      query(
        `SELECT
          wm.*,
          a.reference_no,
          j.code AS job_code, j.title AS job_title, j.accent_color,
          i.id AS linked_interview_id, i.visit_token, i.scheduled_date, i.start_time, i.meeting_url,
          i.booking_status, i.interview_mode, i.location_building, i.location_floor, i.location_office, i.location_maps_url
        FROM wa_messages wm
        LEFT JOIN applications a ON a.id = wm.application_id
        LEFT JOIN jobs j ON j.id = a.job_id
        LEFT JOIN interviews i ON i.id = wm.interview_id
        ${whereSql}
        ORDER BY
          CASE wm.queue_status WHEN 'queued' THEN 1 WHEN 'sent' THEN 2 ELSE 3 END,
          wm.created_at DESC`,
        params
      ),
      query("SELECT setting_value FROM system_settings WHERE setting_key = 'whatsapp_templates'"),
      getCompanyLocationConfig()
    ]);

    const origin = getBaseOrigin(req);
    const enrichedMessages = msgRes.rows.map(({ visit_token, linked_interview_id, ...m }) => ({
      ...m,
      visit_url: linked_interview_id && visit_token
        ? buildVisitPassUrl(origin, linked_interview_id, visit_token)
        : origin
    }));

    res.json({
      messages: enrichedMessages,
      templates: tplRes.rows[0]?.setting_value || {},
      company_location: locCfg
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// حفظ قوالب واتساب بالدمج الذري (JSONB ||) للحفاظ على كافة المفاتيح والقيم الأخرى الموجودة في القاعدة
app.put('/api/wa-templates', requireAuth(['super_admin', 'hr_coordinator']), async (req, res) => {
  try {
    const incoming = req.body?.templates;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ error: 'بيانات القوالب غير صالحة.' });
    }

    const { rows } = await query(
      `INSERT INTO system_settings (setting_key, setting_value, category, description, updated_by, updated_at)
       VALUES ('whatsapp_templates', $1::jsonb, 'whatsapp_templates', 'قوالب رسائل واتساب الهجينة', $2, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET
         setting_value = COALESCE(system_settings.setting_value, '{}'::jsonb) || $1::jsonb,
         updated_by = $2,
         updated_at = NOW()
       RETURNING setting_value`,
      [JSON.stringify(incoming), req.user.full_name]
    );

    res.json({ message: 'تم حفظ القالب بنجاح مع الاحتفاظ بكافة القوالب الأخرى!', templates: rows[0]?.setting_value || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wa-messages', requireAuth(['super_admin', 'hr_coordinator']), async (req, res) => {
  try {
    const { application_id, interview_id, recipient_name, recipient_phone, message_body, template_key = 'custom', open_draft = false } = req.body || {};
    if (template_key === 'portal_recovery') {
      return res.status(400).json({
        error: 'رسائل استعادة الوصول (portal_recovery) تُولَّد حصراً عبر مسار تدوير رمز الاستعادة الرسمي.',
        code: 'INVALID_WA_TEMPLATE_KEY'
      });
    }
    if (!recipient_name || !recipient_phone || !message_body) {
      return res.status(400).json({ error: 'اسم المستلم ورقم الجوال ونص الرسالة مطلوبة.' });
    }
    const cleanPhone = normalizePhoneForWa(recipient_phone);
    if (cleanPhone.length < 9) {
      return res.status(400).json({ error: 'رقم الجوال غير صالح.' });
    }
    const waLink = buildWaLink(cleanPhone, message_body);

    const { rows } = await query(
      `INSERT INTO wa_messages (application_id, interview_id, template_key, recipient_name, recipient_phone, message_body, wa_link, queue_status, prepared_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued', CASE WHEN $8::boolean THEN NOW() ELSE NULL END)
       RETURNING *`,
      [
        application_id ? parseInt(application_id, 10) : null,
        interview_id ? parseInt(interview_id, 10) : null,
        template_key,
        recipient_name,
        cleanPhone,
        message_body,
        waLink,
        Boolean(open_draft)
      ]
    );
    res.status(201).json({ message: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/wa-messages/:id', requireAuth(['super_admin', 'hr_coordinator']), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'معرّف الرسالة غير صالح.' });
  }

  const { action, queue_status, message_body } = req.body || {};
  const actorName = req.user.full_name;

  // 1. رفض أي تعارض أو قيم غير معروفة في المعاملات من البوابة الأولى قبل قراءة الحالة
  if (action !== undefined && queue_status !== undefined) {
    return res.status(400).json({
      error: 'لا يُسمح بإرسال المعاملين (action) و(queue_status) معاً في طلب واحد منعاً لتعارض انتقال الحالة.',
      code: 'CONFLICTING_WA_PARAMS'
    });
  }
  if (action !== undefined && !['open_draft', 'confirm_sent'].includes(action)) {
    return res.status(400).json({
      error: 'قيمة الإجراء (action) غير صالحة؛ القيم المسموحة هي open_draft أو confirm_sent فقط.',
      code: 'INVALID_WA_ACTION'
    });
  }
  if (queue_status !== undefined && !['queued', 'sent', 'confirmed', 'failed', 'cancelled'].includes(queue_status)) {
    return res.status(400).json({
      error: 'قيمة حالة الرسالة (queue_status) غير صالحة.',
      code: 'INVALID_WA_STATUS'
    });
  }
  if (action === undefined && queue_status === undefined && message_body === undefined) {
    return res.status(400).json({
      error: 'لم يتم تحديد أي إجراء أو تحديث صالح على الرسالة.',
      code: 'EMPTY_WA_PATCH'
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 2. قفل هرمي بترتيب موحّد (interviews أولاً ثم wa_messages ثانياً) لمنع أي Deadlock متبادل (AB-BA) مع إعادة الجدولة المتزامنة
    const preLookup = await client.query('SELECT id, interview_id FROM wa_messages WHERE id = $1', [id]);
    if (!preLookup.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الرسالة غير موجودة في الطابور.' });
    }

    let linkedInt = null;
    if (preLookup.rows[0].interview_id) {
      const intRes = await client.query('SELECT * FROM interviews WHERE id = $1 FOR UPDATE', [preLookup.rows[0].interview_id]);
      linkedInt = intRes.rows[0] || null;
    }

    const existing = await client.query('SELECT * FROM wa_messages WHERE id = $1 FOR UPDATE', [id]);
    const current = existing.rows[0];

    // 3. الحالة النهائية الصارمة: الرسالة الملغاة (cancelled) لا تقبل أي تعديل أو فتح مسودة أو إعادة تفعيل إطلاقاً
    if (current.queue_status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'هذه الرسالة ملغاة نهائياً (بسبب تحديث أو إلغاء الموعد أو إصدار رمز أحدث) ولا يمكن تنفيذ أي إجراء عليها.',
        code: 'WA_MESSAGE_CANCELLED'
      });
    }

    // 4. منع تعديل نص رسائل استعادة الوصول (portal_recovery) صراحةً
    if (
      current.template_key === 'portal_recovery' &&
      message_body !== undefined &&
      String(message_body) !== String(current.message_body)
    ) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'نص رسالة استعادة الوصول محمي ولا يُسمح بتعديله حفاظاً على الرابط الموقّع ومفتاح الدخول السري.',
        code: 'RECOVERY_BODY_IMMUTABLE'
      });
    }

    const inviteTemplates = ['interview_invite', 'interview_inperson', 'reschedule_notice'];
    const isInviteLifecycleMsg = inviteTemplates.includes(current.template_key);
    const requestedStatus = action === 'confirm_sent'
      ? 'sent'
      : action === 'open_draft'
        ? 'queued'
        : (queue_status !== undefined ? queue_status : current.queue_status);

    // 5. إذا كان الموعد المرتبط ملغى، لا يُسمح بأي إجراء غير إلغاء الرسالة نفسها
    if (linkedInt && linkedInt.booking_status === 'cancelled' && requestedStatus !== 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'الموعد المرتبط بهذه الرسالة ملغى؛ لا يمكن إرسال أو تأكيد دعوة لموعد ملغى.',
        code: 'INTERVIEW_ALREADY_CANCELLED'
      });
    }

    // 6. منع العمل على رسالة دعوة قديمة تجاوزتها رسالة دعوة أحدث لنفس الموعد
    if (linkedInt && isInviteLifecycleMsg && requestedStatus !== 'cancelled') {
      const latestMsgRes = await client.query(
        `SELECT MAX(id) AS max_id
         FROM wa_messages
         WHERE interview_id = $1
           AND template_key = ANY($2::varchar[])
           AND queue_status <> 'cancelled'`,
        [linkedInt.id, inviteTemplates]
      );
      const maxActiveId = latestMsgRes.rows[0]?.max_id ? Number(latestMsgRes.rows[0].max_id) : null;
      if (maxActiveId && current.id < maxActiveId) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'توجد دعوة أحدث لهذا الموعد؛ لا يمكن تفعيل أو تأكيد رسالة قديمة متجاوَزة.',
          code: 'SUPERSEDED_WA_MESSAGE'
        });
      }
    }

    // 7. التحقق الصارم والشامل من جدول انتقال الحالات (Exhaustive State Transition Matrix)
    if (action === 'open_draft') {
      if (current.queue_status !== 'queued') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `لا يمكن فتح المسودة كرسالة قيد الإعداد وهي في حالة (${current.queue_status}).`,
          code: 'INVALID_WA_TRANSITION'
        });
      }
      const draftBody = current.template_key === 'portal_recovery'
        ? current.message_body
        : (message_body !== undefined ? String(message_body) : current.message_body);
      if (!String(draftBody).trim()) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'نص الرسالة لا يمكن أن يكون فارغاً.' });
      }
      const draftLink = buildWaLink(current.recipient_phone, draftBody);

      const { rows } = await client.query(
        `UPDATE wa_messages SET
          message_body = $1,
          wa_link = $2,
          prepared_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [draftBody, draftLink, id]
      );
      await client.query('COMMIT');

      await logAudit({
        actor: actorName,
        actorRole: req.user.role,
        action: 'WA_DRAFT_OPENED',
        entityType: 'wa_message',
        entityId: id,
        metadata: { recipient: current.recipient_name, template_key: current.template_key, queue_status: rows[0].queue_status },
        ipAddress: req.ip
      });

      return res.json({ message: rows[0] });
    }

    const fromStatus = current.queue_status;
    const toStatus = requestedStatus;

    if (toStatus === 'sent') {
      if (fromStatus !== 'queued') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `لا يمكن تأكيد إرسال رسالة من الحالة (${fromStatus})؛ يجب أن تكون في الطابور (queued).`,
          code: 'INVALID_WA_TRANSITION'
        });
      }
    } else if (toStatus === 'confirmed') {
      if (fromStatus === 'queued') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'لا يمكن تسجيل تأكيد حضور على رسالة ما زالت في الطابور (queued) ولم يتأكد إرسالها بعد.',
          code: 'CANNOT_CONFIRM_UNSENT_MESSAGE'
        });
      }
      if (fromStatus !== 'sent') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `لا يمكن نقل الرسالة إلى (confirmed) من الحالة (${fromStatus}).`,
          code: 'INVALID_WA_TRANSITION'
        });
      }
      if (current.template_key === 'portal_recovery') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'رسائل استعادة الوصول ليست دعوات مقابلة ولا تقبل حالة تأكيد الحضور.',
          code: 'INVALID_WA_TRANSITION'
        });
      }
      if (linkedInt && !['invitation_sent', 'confirmed'].includes(linkedInt.booking_status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'لا يمكن تأكيد حضور موعد لم تُسجل دعوته كمرسلة نشطة بعد.',
          code: 'INVITATION_NOT_SENT_YET'
        });
      }
    } else if (toStatus === 'queued') {
      if (!['queued', 'failed'].includes(fromStatus)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `لا يمكن إرجاع رسالة بعد إرسالها أو تأكيدها (${fromStatus}) إلى الطابور (queued).`,
          code: 'INVALID_WA_TRANSITION'
        });
      }
    } else if (toStatus === 'failed') {
      if (!['queued', 'sent'].includes(fromStatus)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `لا يمكن وسم رسالة في حالة (${fromStatus}) كفاشلة.`,
          code: 'INVALID_WA_TRANSITION'
        });
      }
    }

    // السجل التاريخي للرسالة بعد الإرسال غير قابل للتزوير؛ يُسمح بتعديل النص فقط والرسالة في حالة queued
    if (fromStatus !== 'queued' && message_body !== undefined && String(message_body) !== String(current.message_body)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'لا يمكن تعديل نص الرسالة بعد خروجها من حالة الطابور (queued) حفاظاً على السجل التدقيقي.',
        code: 'SENT_BODY_IMMUTABLE'
      });
    }

    const finalBody = fromStatus === 'queued' && current.template_key !== 'portal_recovery' && message_body !== undefined
      ? String(message_body)
      : current.message_body;
    if (!String(finalBody).trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'نص الرسالة لا يمكن أن يكون فارغاً.' });
    }
    const finalLink = buildWaLink(current.recipient_phone, finalBody);

    const { rows } = await client.query(
      `UPDATE wa_messages SET
        message_body = $1,
        wa_link = $2,
        queue_status = $3::varchar,
        sent_by = CASE
          WHEN $3::varchar = 'queued' THEN NULL
          WHEN $3::varchar IN ('sent','confirmed') THEN $4
          ELSE sent_by
        END,
        sent_at = CASE
          WHEN $3::varchar = 'queued' THEN NULL
          WHEN $3::varchar = 'sent' AND sent_at IS NULL THEN NOW()
          ELSE sent_at
        END,
        prepared_at = CASE
          WHEN $3::varchar = 'queued' AND $5::varchar = 'failed' THEN NULL
          ELSE prepared_at
        END
      WHERE id = $6
      RETURNING *`,
      [finalBody, finalLink, toStatus, actorName, fromStatus, id]
    );

    if (linkedInt && isInviteLifecycleMsg && toStatus === 'sent' && ['scheduled', 'rescheduled'].includes(linkedInt.booking_status)) {
      await client.query(
        `UPDATE interviews
         SET booking_status = 'invitation_sent', updated_at = NOW()
         WHERE id = $1 AND booking_status IN ('scheduled', 'rescheduled')`,
        [linkedInt.id]
      );
    } else if (linkedInt && isInviteLifecycleMsg && toStatus === 'confirmed' && ['invitation_sent', 'confirmed'].includes(linkedInt.booking_status)) {
      await client.query(
        `UPDATE interviews
         SET booking_status = 'confirmed', updated_at = NOW()
         WHERE id = $1 AND booking_status IN ('invitation_sent', 'confirmed')`,
        [linkedInt.id]
      );
    }

    await client.query('COMMIT');

    await logAudit({
      actor: actorName,
      actorRole: req.user.role,
      action: toStatus === 'sent' ? 'WA_SEND_CONFIRMED' : 'WA_MESSAGE_UPDATED',
      entityType: 'wa_message',
      entityId: id,
      metadata: { from_status: fromStatus, to_status: toStatus, template_key: current.template_key, recipient: current.recipient_name },
      ipAddress: req.ip
    });

    res.json({ message: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------------
// 9B. بوابة رسائل واتساب التشغيلية عبر WAHA (v2.3) — Dry-Run إلزامي + مفتاح إيقاف فوري
//     المسارات: /api/waha/status · /api/waha/config · /api/waha/kill-switch ·
//               /api/wa-messages/:id/dispatch-waha · /api/waha/dry-run-outbox · /api/webhooks/waha
// ---------------------------------------------------------------------------------
app.use('/api', createWahaRoutes({
  query,
  pool,
  logAudit,
  requireAuth,
  wahaClient
}));

// ---------------------------------------------------------------------------------
// 9C. قاعات الفيديو الخاصة عبر Jitsi (v2.4) — جلسة القاعة + قياس الجلسة + بطاقة المرشح
//     المسارات: /api/jitsi/status · /api/interviews/:id/room-session ·
//               /api/interviews/:id/room-telemetry · /api/public/interviews/room-pass
// ---------------------------------------------------------------------------------
app.use('/api', createJitsiRoutes({
  query,
  logAudit,
  requireAuth,
  jitsiClient
}));

// ---------------------------------------------------------------------------------
// 9D. مصفوفة المقارنة والعروض الوظيفية وأتمتة n8n (v2.5)
//     المسارات: /api/compare · /api/offers* · /api/public/offers/:ot
// ---------------------------------------------------------------------------------
app.use('/api', createOfferRoutes({
  query,
  pool,
  logAudit,
  requireAuth,
  offerPdf,
  outbox,
  uploadsDir
}));

// ---------------------------------------------------------------------------------
// 9E. حالة صندوق الأتمتة (n8n) — قراءة فقط للمشرف، ولا تكشف أي سر
// ---------------------------------------------------------------------------------
app.get('/api/automation/outbox-status', requireAuth(['super_admin', 'hr_coordinator']), async (_req, res) => {
  try {
    const stats = await outbox.outboxStats(query);
    res.json({
      delivery_enabled: outbox.isDeliveryEnabled(),
      // لا يُعاد العنوان ولا السر — فقط حالة التحقق منه
      webhook_configured: outbox.validateWebhookUrl(process.env.N8N_OFFER_WEBHOOK_URL).ok,
      secret_configured: Boolean(process.env.N8N_WEBHOOK_SECRET),
      non_blocking: true,
      stats
    });
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'OUTBOX_STATUS_FAILED' });
  }
});

// ---------------------------------------------------------------------------------
// 9F. عامل صندوق الأتمتة — يعمل في الخلفية ولا يعطّل أي طلب توظيف إطلاقاً
//     • لا ينفّذ شيئاً إن كانت الأتمتة معطّلة (الافتراضي)
//     • كل الأخطاء تُلتقط داخلياً: لا unhandled rejection، لا تأخير على مسار الطلب
//     • يُنفَّذ التسليم بعد استجابة الطلب (setImmediate) لا قبله
// ---------------------------------------------------------------------------------
const OUTBOX_WORKER_INTERVAL_MS = Number(process.env.OUTBOX_WORKER_INTERVAL_MS || 5000);
let outboxWorkerTimer = null;
let outboxWorkerBusy = false;

async function runOutboxWorkerTick() {
  if (outboxWorkerBusy) return;
  outboxWorkerBusy = true;
  try {
    const stats = await outbox.deliverBatch(query, { limit: 10 });
    if (stats.delivered || stats.failed) {
      console.log(`[outbox] attempted=${stats.attempted} delivered=${stats.delivered} failed=${stats.failed} abandoned=${stats.abandoned}`);
    }
  } catch (err) {
    // لا شيء يفشل هنا: الصندوق ملحق عرضي لجودة التشغيل
    console.error('[outbox] worker tick failed (non-fatal):', err && err.message);
  } finally {
    outboxWorkerBusy = false;
  }
}

if (OUTBOX_WORKER_INTERVAL_MS > 0) {
  outboxWorkerTimer = setInterval(() => { setImmediate(runOutboxWorkerTick); }, OUTBOX_WORKER_INTERVAL_MS);
  if (typeof outboxWorkerTimer.unref === 'function') outboxWorkerTimer.unref();
  // دورة أولى بعد 1.5 ثانية من الإقلاع (لا تُبقي العملية حيّة)
  const firstTick = setTimeout(() => { setImmediate(runOutboxWorkerTick); }, 1500);
  if (typeof firstTick.unref === 'function') firstTick.unref();
}

// ---------------------------------------------------------------------------------
// 10. إعدادات المقر وصورة المدخل ومحاكي الفحص الأعمى وسجل التدقيق
// ---------------------------------------------------------------------------------

app.post('/api/settings/upload-location-image', requireAuth(['super_admin', 'hr_coordinator']), uploadPublicImage.single('entrance_image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'لم يتم اختيار صورة صالحة لمدخل المقر.' });
  }
  res.json({
    entrance_image_url: `/uploads/public/${req.file.filename}`,
    size_kb: Math.round(req.file.size / 1024)
  });
});

app.put('/api/settings/company_location', requireAuth(['super_admin', 'hr_coordinator']), async (req, res) => {
  try {
    const val = req.body?.setting_value;
    if (!val || typeof val !== 'object') {
      return res.status(400).json({ error: 'بيانات المقر غير صالحة.' });
    }
    const { rows } = await query(
      `INSERT INTO system_settings (setting_key, setting_value, category, description, updated_by, updated_at)
       VALUES ('company_location', $1::jsonb, 'scheduler', 'بيانات مقر المقابلات الحضورية ورقم واتساب الموارد البشرية', $2, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET
         setting_value = $1::jsonb,
         updated_by = $2,
         updated_at = NOW()
       RETURNING *`,
      [JSON.stringify(val), req.user.full_name]
    );
    res.json({ setting: rows[0], message: 'تم حفظ بيانات المقر وصورة المدخل ورقم التواصل بنجاح!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/simulate', requireAuth(), async (req, res) => {
  try {
    const { sample_cv_text = '', candidate_name = '', job_id } = req.body;
    const anonymized = anonymizeText(sample_cv_text, { full_name: candidate_name });

    let job = {
      code: 'SL-204',
      title: 'مندوب مبيعات حلول الدهانات المعمارية والصناعية',
      department: 'المبيعات',
      passing_score: 60,
      ai_prompt: 'قيّم المتقدم بنظام الفحص الأعمى...',
      questions: []
    };

    if (job_id) {
      const jRes = await query('SELECT * FROM jobs WHERE id = $1', [parseInt(job_id, 10)]);
      if (jRes.rows.length) job = jRes.rows[0];
    }

    const settingsRes = await query("SELECT setting_value FROM system_settings WHERE setting_key = 'ai_engine_config'");
    const aiConfig = settingsRes.rows[0]?.setting_value || {};

    const evalPreview = await evaluateSubmission({
      job: { ...job, questions: (job.questions || []).slice(0, 3) },
      candidate: {
        full_name: candidate_name,
        years_experience: 4,
        qualification: 'بكالوريوس',
        specialization: 'هندسة كيميائية',
        cv_filename: 'simulated.pdf',
        cv_extracted_text: anonymized
      },
      answers: [
        { question_index: 1, answer_value: '1' },
        { question_index: 2, answer_value: '400' },
        { question_index: 3, answer_value: '1' }
      ],
      telemetry: { tab_switches: 0, paste_attempts: 0 },
      aiConfig
    });

    res.json({
      original_length: sample_cv_text.length,
      anonymized_text: anonymized,
      blind_code: evalPreview.aiReport.blind_code,
      cv_match_score: evalPreview.cvMatchScore,
      integrity_score: evalPreview.integrityScore,
      ai_report: evalPreview.aiReport
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings', requireAuth(['super_admin', 'hr_coordinator']), async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM system_settings ORDER BY setting_key ASC');
    const settingsMap = {};
    for (const r of rows) {
      settingsMap[r.setting_key] = r.setting_value;
    }
    res.json({
      settings: settingsMap,
      raw_rows: rows,
      env_providers: getProvidersEnvStatus()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings/:key', requireAuth(['super_admin']), async (req, res) => {
  try {
    const { key } = req.params;
    const { setting_value, category = 'ai_provider', description = '' } = req.body;

    if (!setting_value || typeof setting_value !== 'object') {
      return res.status(400).json({ error: 'قيمة الإعداد يجب أن تكون كائن JSON صالحاً.' });
    }

    const sanitizedValue = { ...setting_value };
    delete sanitizedValue.api_key;
    delete sanitizedValue.secret_key;
    delete sanitizedValue.OPENAI_API_KEY;
    delete sanitizedValue.GEMINI_API_KEY;

    const { rows } = await query(
      `INSERT INTO system_settings (setting_key, setting_value, category, description, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, $4, $5, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET
         setting_value = EXCLUDED.setting_value,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING *`,
      [key, JSON.stringify(sanitizedValue), category, description, req.user.full_name]
    );

    if (key === 'ranking_weights') {
      await query('SELECT fn_sync_application_weighted_score(id) FROM applications');
    }

    await logAudit({
      actor: req.user.full_name,
      actorRole: req.user.role,
      action: 'SYSTEM_SETTING_UPDATED',
      entityType: 'system_settings',
      entityId: key,
      metadata: sanitizedValue,
      ipAddress: req.ip
    });

    res.json({ setting: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/audit-logs', requireAuth(['super_admin']), async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit || '30', 10));
    const { rows } = await query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1', [limit]);
    res.json({ logs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------------
// 11. استقبال المرشحين الذكي بالـ QR وتنبيه اللجنة اللحظي (v2.2a — Smart Reception)
// ---------------------------------------------------------------------------------

function parseReceptionQrInput(rawInput) {
  const s = String(rawInput || '').trim();
  if (!s) return null;
  if (s.startsWith('JPFQR:')) {
    const parsed = verifyReceptionQrToken(s.slice(6).trim());
    return parsed ? { interviewId: parseInt(parsed.sub, 10), nonce: String(parsed.n), source: 'qr_token' } : null;
  }
  const directQr = verifyReceptionQrToken(s);
  if (directQr) {
    return { interviewId: parseInt(directQr.sub, 10), nonce: String(directQr.n), source: 'qr_token' };
  }
  try {
    if (s.includes('vt=')) {
      const vtParam = new URL(s, 'https://hrjpf.tech').searchParams.get('vt');
      const parsedVt = vtParam ? verifyVisitPassToken(vtParam) : null;
      if (parsedVt) {
        return { interviewId: parseInt(parsedVt.sub, 10), nonce: String(parsedVt.n), source: 'visit_url' };
      }
    }
  } catch (_e) {}
  return null;
}

function verifyNonceTimingSafe(actualNonce32, dbVisitToken) {
  const expected = String(dbVisitToken || '').slice(0, 32);
  if (!expected || !actualNonce32) return false;
  const a = Buffer.from(String(actualNonce32));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function formatReceptionCard(row, locCfg, riyadhTodayStr) {
  const dateStr = row.scheduled_date instanceof Date
    ? row.scheduled_date.toISOString().slice(0, 10)
    : String(row.scheduled_date || '').slice(0, 10);
  return {
    interview_id: row.id,
    application_id: row.application_id,
    reference_no: row.reference_no,
    checkin_code_tail: String(row.reference_no || '').slice(-4),
    full_name: row.full_name,
    job_code: row.job_code,
    job_title: row.job_title,
    department: row.department,
    interview_mode: row.interview_mode || 'remote',
    scheduled_date: dateStr,
    is_scheduled_today: dateStr === riyadhTodayStr,
    start_time: String(row.start_time || '').slice(0, 5),
    end_time: String(row.end_time || '').slice(0, 5),
    duration_minutes: row.duration_minutes,
    booking_status: row.booking_status,
    lobby_status: row.lobby_status || 'not_arrived',
    checked_in_at: row.checked_in_at || null,
    checked_in_by: row.checked_in_by || null,
    punctuality_minutes: row.punctuality_minutes ?? null,
    interviewer_panel: row.interviewer_panel,
    building: row.location_building || locCfg.building_name,
    floor: row.location_floor || locCfg.floor_number,
    office: row.location_office || locCfg.office_number
  };
}

app.post('/api/reception/verify-qr', requireAuth(['super_admin', 'hr_coordinator']), async (req, res) => {
  try {
    const { qr_payload, reference_query } = req.body || {};
    if (!qr_payload && !reference_query) {
      return res.status(400).json({ error: 'يرجى مسح رمز الـ QR أو إدخال الرقم المرجعي للمرشح.', code: 'MISSING_RECEPTION_QUERY' });
    }

    const [locCfg, todayRes] = await Promise.all([
      getCompanyLocationConfig(),
      query("SELECT (NOW() AT TIME ZONE 'Asia/Riyadh')::date::text AS today_riyadh")
    ]);
    const riyadhTodayStr = todayRes.rows[0].today_riyadh;

    if (qr_payload) {
      const parsed = parseReceptionQrInput(qr_payload);
      if (!parsed || !Number.isInteger(parsed.interviewId) || parsed.interviewId <= 0) {
        return res.status(403).json({
          error: 'رمز الاستقبال غير صالح أو منتهي الصلاحية.',
          code: 'INVALID_CHECKIN_QR'
        });
      }

      const { rows } = await query(
        `SELECT i.*, a.reference_no, c.full_name, j.code AS job_code, j.title AS job_title, j.department
         FROM interviews i
         JOIN applications a ON a.id = i.application_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN jobs j ON j.id = a.job_id
         WHERE i.id = $1`,
        [parsed.interviewId]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'لم يتم العثور على سجل الموعد.', code: 'INTERVIEW_NOT_FOUND' });
      }
      const row = rows[0];
      if (!verifyNonceTimingSafe(parsed.nonce, row.visit_token)) {
        return res.status(403).json({
          error: 'تم تحديث هذا الموعد أو إلغاؤه وأصبحت بطاقة الـ QR القديمة ملغاة.',
          code: 'REVOKED_CHECKIN_QR'
        });
      }
      if (row.booking_status === 'cancelled') {
        return res.status(400).json({ error: 'هذا الموعد ملغى حالياً.', code: 'INTERVIEW_CANCELLED' });
      }
      return res.json({
        verified: true,
        source: parsed.source,
        today_riyadh: riyadhTodayStr,
        candidate_arrival: formatReceptionCard(row, locCfg, riyadhTodayStr)
      });
    }

    const cleanQuery = String(reference_query || '').trim().toUpperCase();
    if (cleanQuery.length < 3) {
      return res.status(400).json({ error: 'يرجى إدخال آخر 4 أرقام على الأقل من الرقم المرجعي للطلب.' });
    }

    const { rows } = await query(
      `SELECT i.*, a.reference_no, c.full_name, j.code AS job_code, j.title AS job_title, j.department
       FROM interviews i
       JOIN applications a ON a.id = i.application_id
       JOIN candidates c ON c.id = a.candidate_id
       JOIN jobs j ON j.id = a.job_id
       WHERE i.booking_status <> 'cancelled'
         AND (UPPER(a.reference_no) = $1 OR RIGHT(UPPER(a.reference_no), 4) = $1)
       ORDER BY (i.scheduled_date = (NOW() AT TIME ZONE 'Asia/Riyadh')::date) DESC, i.scheduled_date ASC
       LIMIT 5`,
      [cleanQuery]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'لا يوجد موعد نشط مطابق لهذا الرقم المرجعي.', code: 'INTERVIEW_NOT_FOUND' });
    }
    if (rows.length > 1) {
      return res.status(409).json({
        error: 'يوجد أكثر من موعد بنفس الأرقام الأخيرة؛ يرجى إدخال الرقم المرجعي الكامل (APP-...) أو مسح رمز الـ QR.',
        code: 'AMBIGUOUS_REFERENCE_TAIL'
      });
    }

    res.json({
      verified: true,
      source: 'reference_lookup',
      today_riyadh: riyadhTodayStr,
      candidate_arrival: formatReceptionCard(rows[0], locCfg, riyadhTodayStr)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reception/check-in', requireAuth(['super_admin', 'hr_coordinator']), async (req, res) => {
  const { qr_payload, interview_id, force_date_override = false } = req.body || {};
  let targetInterviewId = interview_id ? parseInt(interview_id, 10) : null;
  let parsedQr = null;

  if (qr_payload) {
    parsedQr = parseReceptionQrInput(qr_payload);
    if (!parsedQr || !Number.isInteger(parsedQr.interviewId) || parsedQr.interviewId <= 0) {
      return res.status(403).json({ error: 'رمز الـ QR غير صالح أو مزور.', code: 'INVALID_CHECKIN_QR' });
    }
    targetInterviewId = parsedQr.interviewId;
  }

  if (!Number.isInteger(targetInterviewId) || targetInterviewId <= 0) {
    return res.status(400).json({ error: 'يلزم تحديد الموعد أو مسح رمز الـ QR لتسجيل الوصول.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const curRes = await client.query(
      `SELECT i.*, a.reference_no, c.full_name, j.code AS job_code, j.title AS job_title, j.department,
              (NOW() AT TIME ZONE 'Asia/Riyadh')::date::text AS today_riyadh,
              ROUND(
                EXTRACT(EPOCH FROM (
                  ((i.scheduled_date::text || ' ' || i.start_time::text)::timestamp AT TIME ZONE 'Asia/Riyadh') - NOW()
                )) / 60.0
              )::int AS computed_punctuality_min
       FROM interviews i
       JOIN applications a ON a.id = i.application_id
       JOIN candidates c ON c.id = a.candidate_id
       JOIN jobs j ON j.id = a.job_id
       WHERE i.id = $1
       FOR UPDATE OF i`,
      [targetInterviewId]
    );
    if (!curRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الموعد غير موجود.', code: 'INTERVIEW_NOT_FOUND' });
    }
    const cur = curRes.rows[0];

    if (parsedQr && !verifyNonceTimingSafe(parsedQr.nonce, cur.visit_token)) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'بطاقة الـ QR مبطلة بسبب تعديل أو إلغاء الموعد؛ يرجى التحقق من البطاقة المحدّثة.',
        code: 'REVOKED_CHECKIN_QR'
      });
    }

    if (['cancelled', 'no_show'].includes(cur.booking_status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'هذا الموعد ملغى أو مغلق ولا يمكن تسجيل وصول عليه.',
        code: 'INTERVIEW_NOT_ACTIVE'
      });
    }
    if (cur.booking_status === 'completed') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'تمت هذه المقابلة مسبقاً.',
        code: 'INTERVIEW_ALREADY_COMPLETED'
      });
    }

    const riyadhTodayStr = cur.today_riyadh;
    const schedDateStr = cur.scheduled_date instanceof Date
      ? cur.scheduled_date.toISOString().slice(0, 10)
      : String(cur.scheduled_date || '').slice(0, 10);

    // منع تسجيل وصول بالخطأ لموعد في تاريخ آخر إلا بتجاوز صريح من منسق التوظيف
    if (schedDateStr !== riyadhTodayStr && !force_date_override) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `تاريخ مقابلة المرشح هو (${schedDateStr}) وليس اليوم (${riyadhTodayStr}). لتسجيل وصول استثنائي فعّل خيار التجاوز الصريح.`,
        code: 'WRONG_INTERVIEW_DATE',
        scheduled_date: schedDateStr,
        today_riyadh: riyadhTodayStr
      });
    }

    const locCfg = await getCompanyLocationConfig();

    // إدمبوتنسي ذرية: إذا مسح المنسق الرمز مرتين بالتزامن لا يُعاد الكتابة فوق وقت الوصول الأصلي
    if (cur.lobby_status === 'checked_in' && cur.checked_in_at) {
      await client.query('ROLLBACK');
      return res.status(200).json({
        already_checked_in: true,
        message: 'تم تسجيل وصول هذا المرشح مسبقاً وهو بانتظار اللجنة.',
        candidate_arrival: formatReceptionCard(cur, locCfg, riyadhTodayStr)
      });
    }

    const updRes = await client.query(
      `UPDATE interviews
       SET lobby_status = 'checked_in',
           checked_in_at = NOW(),
           checked_in_by = $1,
           punctuality_minutes = $2,
           booking_status = CASE
             WHEN booking_status IN ('scheduled', 'rescheduled', 'invitation_sent') THEN 'confirmed'
             ELSE booking_status
           END,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [req.user.full_name, cur.computed_punctuality_min, cur.id]
    );

    await client.query('COMMIT');

    const mergedRow = { ...cur, ...updRes.rows[0] };
    await logAudit({
      actor: req.user.full_name,
      actorRole: req.user.role,
      action: 'CANDIDATE_QR_CHECKED_IN',
      entityType: 'interview',
      entityId: cur.reference_no,
      metadata: {
        interview_id: cur.id,
        punctuality_minutes: mergedRow.punctuality_minutes,
        office: mergedRow.location_office || locCfg.office_number,
        via_qr: Boolean(parsedQr)
      },
      ipAddress: req.ip
    });

    res.json({
      already_checked_in: false,
      message: `تم تسجيل وصول ${cur.full_name} وإرسال تنبيه فوري لأعضاء اللجنة 🔔`,
      candidate_arrival: formatReceptionCard(mergedRow, locCfg, riyadhTodayStr)
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/reception/arrivals/:interviewId/acknowledge', requireAuth(['super_admin', 'hr_coordinator', 'committee_member']), async (req, res) => {
  const client = await pool.connect();
  try {
    const intvId = parseInt(req.params.interviewId, 10);
    if (!intvId) {
      return res.status(400).json({ error: 'معرّف المقابلة غير صالح.' });
    }

    await client.query('BEGIN');
    const curRes = await client.query(
      `SELECT i.*, a.reference_no, c.full_name, j.code AS job_code, j.title AS job_title, j.department
       FROM interviews i
       JOIN applications a ON a.id = i.application_id
       JOIN candidates c ON c.id = a.candidate_id
       JOIN jobs j ON j.id = a.job_id
       WHERE i.id = $1
       FOR UPDATE OF i`,
      [intvId]
    );
    if (!curRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الموعد غير موجود.' });
    }
    const cur = curRes.rows[0];

    if (['completed', 'cancelled', 'no_show'].includes(cur.booking_status) || cur.lobby_status !== 'checked_in') {
      await client.query('ROLLBACK');
      return res.json({
        already_acknowledged: true,
        lobby_status: cur.lobby_status,
        message: 'تم استلام إشعار وصول المرشح مسبقاً.'
      });
    }

    const upd = await client.query(
      `UPDATE interviews
       SET lobby_status = 'in_room',
           updated_at = NOW()
       WHERE id = $1
       RETURNING lobby_status`,
      [intvId]
    );
    await client.query('COMMIT');

    await logAudit({
      actor: req.user.full_name,
      actorRole: req.user.role,
      action: 'CANDIDATE_LOBBY_ACKNOWLEDGED',
      entityType: 'interview',
      entityId: cur.reference_no,
      metadata: { interview_id: intvId, new_lobby_status: upd.rows[0].lobby_status },
      ipAddress: req.ip
    });

    res.json({
      already_acknowledged: false,
      lobby_status: upd.rows[0].lobby_status,
      message: `تم استلام إشعار وصول ${cur.full_name} وإدخاله إلى القاعة ✓`
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/reception/arrivals', requireAuth(), async (_req, res) => {
  try {
    const [locCfg, waitingRes, todayListRes] = await Promise.all([
      getCompanyLocationConfig(),
      query(
        `SELECT i.*, a.reference_no, c.full_name, j.code AS job_code, j.title AS job_title, j.department,
                (NOW() AT TIME ZONE 'Asia/Riyadh')::date::text AS today_riyadh
         FROM interviews i
         JOIN applications a ON a.id = i.application_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN jobs j ON j.id = a.job_id
         WHERE i.lobby_status = 'checked_in'
           AND i.booking_status NOT IN ('completed', 'cancelled', 'no_show')
         ORDER BY i.checked_in_at DESC`
      ),
      query(
        `SELECT i.*, a.reference_no, c.full_name, j.code AS job_code, j.title AS job_title, j.department,
                (NOW() AT TIME ZONE 'Asia/Riyadh')::date::text AS today_riyadh
         FROM interviews i
         JOIN applications a ON a.id = i.application_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN jobs j ON j.id = a.job_id
         WHERE i.scheduled_date = (NOW() AT TIME ZONE 'Asia/Riyadh')::date
           AND i.booking_status NOT IN ('cancelled', 'completed', 'no_show')
         ORDER BY i.start_time ASC`
      )
    ]);

    const riyadhTodayStr = waitingRes.rows[0]?.today_riyadh || todayListRes.rows[0]?.today_riyadh || new Date().toISOString().slice(0, 10);
    const waitingLobby = waitingRes.rows.map((r) => formatReceptionCard(r, locCfg, riyadhTodayStr));
    const todaySchedule = todayListRes.rows.map((r) => formatReceptionCard(r, locCfg, riyadhTodayStr));

    res.json({
      today_riyadh: riyadhTodayStr,
      waiting_count: waitingLobby.length,
      waiting_candidates: waitingLobby,
      today_schedule: todaySchedule
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =================================================================================
// 12. السؤال الصوتي الاختياري 60 ثانية (v2.2b — تخزين معزول + مراجعة بشرية + حذف 30 يوماً)
// =================================================================================
async function runExpiredVoiceRetentionPurge(actorLabel = 'system:retention-janitor', actorRole = 'system', ipAddress = '127.0.0.1') {
  const client = await pool.connect();
  const purgedRefs = [];
  let sweptOrphanCount = 0;
  try {
    await client.query('BEGIN');
    const dueRes = await client.query(
      `SELECT id, reference_no, voice_pitch_path
       FROM applications
       WHERE voice_pitch_path IS NOT NULL
         AND status <> 'offered'
         AND voice_retention_expires_at IS NOT NULL
         AND voice_retention_expires_at <= NOW()
       FOR UPDATE SKIP LOCKED`
    );

    for (const row of dueRes.rows) {
      const diskPath = resolveSafeVoiceDiskPath(row.voice_pitch_path);
      // حذف الملف الفعلي من القرص أولاً قبل تفريغ المسار من قاعدة البيانات لمنع بقاء أي ملف يتيم عند الانقطاع المفاجئ
      if (diskPath) unlinkVoiceFileStrict(diskPath);
      await client.query(
        `UPDATE applications
         SET voice_pitch_path = NULL,
             voice_mime_type = NULL,
             voice_purged_at = NOW(),
             voice_purge_reason = 'retention_30d_expired',
             updated_at = NOW()
         WHERE id = $1`,
        [row.id]
      );
      purgedRefs.push(row.reference_no);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // كنس أي ملفات يتيمة غير مرتبطة بأي سجل حي في قاعدة البيانات (بعد مهلة سماح 5 دقائق لأي عملية رفع جارية)
  try {
    const activeRes = await query('SELECT voice_pitch_path FROM applications WHERE voice_pitch_path IS NOT NULL');
    const activeSet = new Set(activeRes.rows.map((r) => path.basename(String(r.voice_pitch_path))));
    const graceCutoffMs = Date.now() - 5 * 60 * 1000;
    for (const fname of fs.readdirSync(voiceUploadsDir)) {
      if (!fname.startsWith('voice-') || activeSet.has(fname)) continue;
      const fp = resolveSafeVoiceDiskPath(fname);
      if (!fp) continue;
      try {
        const st = fs.statSync(fp);
        if (st.isFile() && st.mtimeMs <= graceCutoffMs) {
          unlinkVoiceFileStrict(fp);
          sweptOrphanCount += 1;
        }
      } catch (_e) {}
    }
  } catch (_e) {}

  for (const refNo of purgedRefs) {
    await logAudit({
      actor: actorLabel,
      actorRole,
      action: 'VOICE_RETENTION_AUTO_PURGED',
      entityType: 'application',
      entityId: refNo,
      metadata: { reason: 'retention_30d_expired' },
      ipAddress
    });
  }
  if (sweptOrphanCount > 0) {
    await logAudit({
      actor: actorLabel,
      actorRole,
      action: 'VOICE_ORPHAN_FILES_SWEPT',
      entityType: 'system',
      entityId: 'voice_pitches',
      metadata: { swept_orphan_count: sweptOrphanCount },
      ipAddress
    });
  }
  return { purged_count: purgedRefs.length, purged_references: purgedRefs, swept_orphan_count: sweptOrphanCount };
}

async function requireVoicePitchEnabled(_req, res, next) {
  const cfg = await getVoicePitchFeatureConfig();
  if (!cfg.enabled) {
    return res.status(503).json({
      error: 'ميزة التعريف الصوتي الاختياري متوقفة حالياً من إعدادات النظام.',
      code: 'VOICE_PITCH_DISABLED'
    });
  }
  next();
}

app.get('/api/system/voice-pitch-config', requireAuth(['super_admin', 'hr_coordinator']), async (_req, res) => {
  const cfg = await getVoicePitchFeatureConfig();
  res.json(cfg);
});

app.patch('/api/system/voice-pitch-config', requireAuth(['super_admin', 'hr_coordinator']), async (req, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    const maxUploads = Math.max(1, Math.min(10, parseInt(req.body?.max_uploads_per_application, 10) || 3));
    const nextVal = { enabled, max_duration_sec: 60, retention_days: 30, max_uploads_per_application: maxUploads };
    await query(
      `INSERT INTO system_settings (setting_key, setting_value, category, description, updated_by, updated_at)
       VALUES ('voice_pitch_config', $1::jsonb, 'security_governance', 'علم تشغيل وحوكمة ميزة التعريف الصوتي الاختياري (60 ثانية)', $2, NOW())
       ON CONFLICT (setting_key) DO UPDATE
         SET setting_value = EXCLUDED.setting_value,
             updated_by = EXCLUDED.updated_by,
             updated_at = NOW()`,
      [JSON.stringify(nextVal), req.user.full_name]
    );
    await logAudit({
      actor: req.user.full_name,
      actorRole: req.user.role,
      action: 'VOICE_PITCH_CONFIG_UPDATED',
      entityType: 'system_settings',
      entityId: 'voice_pitch_config',
      metadata: nextVal,
      ipAddress: req.ip
    });
    res.json({ message: 'تم تحديث إعداد ميزة التعريف الصوتي بنجاح.', ...(await getVoicePitchFeatureConfig()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(
  '/api/applications/:idOrRef/voice-pitch',
  requireVoicePitchEnabled,
  voiceUploadLimiter,
  uploadVoiceMem.single('voice_file'),
  async (req, res) => {
    const client = await pool.connect();
    let newlyWrittenPath = null;
    try {
      const { idOrRef } = req.params;
      const isNum = /^\d+$/.test(idOrRef);
      const consentRaw = String(req.body?.voice_consent || '').trim().toLowerCase();
      if (consentRaw !== 'true' && consentRaw !== '1') {
        return res.status(400).json({
          error: 'يلزم الإقرار بالموافقة الصريحة على تسجيل المقطع الصوتي وسياسة الحذف التلقائي بعد 30 يوماً قبل الحفظ.',
          code: 'VOICE_CONSENT_REQUIRED'
        });
      }

      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'يرجى تسجيل أو إرفاق ملف صوتي صالح.', code: 'MISSING_VOICE_FILE' });
      }

      const detected = detectSafeAudioContainer(req.file.buffer);
      if (!detected) {
        return res.status(400).json({
          error: 'صيغة الملف الثنائية غير مدعومة أو غير صالحة؛ يُسمح فقط بملفات الصوت الحقيقية (WebM, OGG, M4A/MP4, WAV, MP3).',
          code: 'UNSUPPORTED_AUDIO_BINARY'
        });
      }

      const durSec = Math.max(1, Math.min(65, Math.round(Number(req.body?.duration_sec) || 30)));
      if (Number(req.body?.duration_sec) > 65) {
        return res.status(400).json({
          error: 'يتجاوز طول التسجيل الحد الأقصى المسموح (60 ثانية).',
          code: 'VOICE_DURATION_EXCEEDED'
        });
      }

      const featureCfg = await getVoicePitchFeatureConfig();

      await client.query('BEGIN');
      const appRes = await client.query(
        `SELECT id, reference_no, status, candidate_access_token, voice_pitch_path
         FROM applications
         WHERE ${isNum ? 'id = $1' : 'UPPER(reference_no) = UPPER($1)'}
         FOR UPDATE`,
        [isNum ? parseInt(idOrRef, 10) : idOrRef]
      );
      if (!appRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'الطلب غير موجود.' });
      }
      const appRow = appRes.rows[0];

      // التحقق التشفيري الصارم من ملكية المتقدم للطلب (Candidate PoP)
      const rawAccessKey = req.body?.access_key || req.headers['x-candidate-key'] || '';
      if (!hasCandidateOwnershipProof(req, [appRow], rawAccessKey)) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: 'يلزم إثبات ملكية الطلب عبر مفتاح الدخول السري للمتقدم قبل رفع التعريف الصوتي.',
          code: 'CANDIDATE_OWNERSHIP_REQUIRED'
        });
      }

      if (appRow.status === 'rejected') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'تم إغلاق هذا الطلب ولا يمكن رفع مرفقات جديدة عليه.', code: 'APPLICATION_CLOSED' });
      }

      // سقف أقصى لعدد مرات رفع/استبدال المقطع الصوتي لكل طلب لمنع استنزاف القرص
      const uploadCntRes = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM audit_logs WHERE action = 'VOICE_PITCH_UPLOADED' AND entity_id = $1`,
        [appRow.reference_no]
      );
      if (uploadCntRes.rows[0].cnt >= featureCfg.max_uploads_per_application) {
        await client.query('ROLLBACK');
        return res.status(429).json({
          error: `تم بلوغ الحد الأقصى المسموح لرفع/تحديث المقطع الصوتي لهذا الطلب (${featureCfg.max_uploads_per_application} مرات).`,
          code: 'VOICE_APPLICATION_UPLOAD_CAP_REACHED'
        });
      }

      const safeFileName = `voice-${appRow.id}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${detected.ext}`;
      newlyWrittenPath = path.join(voiceUploadsDir, safeFileName);
      fs.writeFileSync(newlyWrittenPath, req.file.buffer, { mode: 0o600 });

      const oldDiskPath = resolveSafeVoiceDiskPath(appRow.voice_pitch_path);

      const updRes = await client.query(
        `UPDATE applications
         SET voice_pitch_path = $1,
             voice_mime_type = $2,
             voice_duration_sec = $3,
             voice_recorded_at = NOW(),
             voice_consent_at = NOW(),
             voice_retention_expires_at = CASE WHEN status = 'offered' THEN NULL ELSE NOW() + INTERVAL '30 days' END,
             voice_purged_at = NULL,
             voice_purge_reason = NULL,
             updated_at = NOW()
         WHERE id = $4
         RETURNING id, reference_no, voice_duration_sec, voice_recorded_at, voice_retention_expires_at`,
        [safeFileName, detected.mime, durSec, appRow.id]
      );

      await client.query('COMMIT');
      if (oldDiskPath && oldDiskPath !== newlyWrittenPath) safeUnlink(oldDiskPath);

      await logAudit({
        actor: `candidate:${appRow.reference_no}`,
        actorRole: 'candidate',
        action: 'VOICE_PITCH_UPLOADED',
        entityType: 'application',
        entityId: appRow.reference_no,
        metadata: { mime: detected.mime, duration_sec: durSec, bytes: req.file.buffer.length },
        ipAddress: req.ip
      });

      res.status(201).json({
        message: 'تم حفظ تعريفك الصوتي الاختياري بنجاح وسيُعرض للمراجعة البشرية من قِبل لجنة التوظيف ✓',
        voice_pitch: {
          has_voice_pitch: true,
          duration_sec: updRes.rows[0].voice_duration_sec,
          recorded_at: updRes.rows[0].voice_recorded_at,
          retention_expires_at: updRes.rows[0].voice_retention_expires_at
        }
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (newlyWrittenPath) safeUnlink(newlyWrittenPath);
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  }
);

app.delete('/api/applications/:idOrRef/voice-pitch', async (req, res) => {
  const client = await pool.connect();
  try {
    const { idOrRef } = req.params;
    const isNum = /^\d+$/.test(idOrRef);
    const staffSession = await resolveActiveStaffSession(req, query);

    await client.query('BEGIN');
    const appRes = await client.query(
      `SELECT id, reference_no, candidate_access_token, voice_pitch_path
       FROM applications
       WHERE ${isNum ? 'id = $1' : 'UPPER(reference_no) = UPPER($1)'}
       FOR UPDATE`,
      [isNum ? parseInt(idOrRef, 10) : idOrRef]
    );
    if (!appRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'الطلب غير موجود.' });
    }
    const appRow = appRes.rows[0];

    const isAllowedStaff = staffSession && ['super_admin', 'hr_coordinator'].includes(staffSession.role);
    const rawAccessKey = req.body?.access_key || req.headers['x-candidate-key'] || '';
    const isOwnerCandidate = hasCandidateOwnershipProof(req, [appRow], rawAccessKey);

    if (!isAllowedStaff && !isOwnerCandidate) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'غير مصرح بحذف المقطع الصوتي إلا للمتقدم صاحب الطلب أو مسؤول الموارد البشرية.',
        code: 'VOICE_DELETE_FORBIDDEN'
      });
    }

    const oldDiskPath = resolveSafeVoiceDiskPath(appRow.voice_pitch_path);
    const reason = isAllowedStaff ? 'staff_deleted' : 'candidate_withdrawn';

    // حذف الملف الفعلي من القرص أولاً داخل القفل قبل تفريغ المؤشر من القاعدة
    if (oldDiskPath) unlinkVoiceFileStrict(oldDiskPath);

    await client.query(
      `UPDATE applications
       SET voice_pitch_path = NULL,
           voice_mime_type = NULL,
           voice_duration_sec = NULL,
           voice_retention_expires_at = NULL,
           voice_purged_at = NOW(),
           voice_purge_reason = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [reason, appRow.id]
    );
    await client.query('COMMIT');

    await logAudit({
      actor: isAllowedStaff ? staffSession.full_name : `candidate:${appRow.reference_no}`,
      actorRole: isAllowedStaff ? staffSession.role : 'candidate',
      action: 'VOICE_PITCH_DELETED',
      entityType: 'application',
      entityId: appRow.reference_no,
      metadata: { reason },
      ipAddress: req.ip
    });

    res.json({ message: 'تم حذف المقطع الصوتي بنجاح وتوثيق العملية في سجل التدقيق.' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/applications/:idOrRef/voice-stream', requireAuth(['super_admin', 'hr_coordinator', 'committee_member']), async (req, res) => {
  try {
    const { idOrRef } = req.params;
    const isNum = /^\d+$/.test(idOrRef);
    const { rows } = await query(
      `SELECT id, reference_no, status, voice_pitch_path, voice_mime_type, voice_retention_expires_at,
              (status <> 'offered' AND voice_retention_expires_at IS NOT NULL AND voice_retention_expires_at <= NOW()) AS is_retention_expired
       FROM applications
       WHERE ${isNum ? 'id = $1' : 'UPPER(reference_no) = UPPER($1)'}`,
      [isNum ? parseInt(idOrRef, 10) : idOrRef]
    );
    if (!rows.length || !rows[0].voice_pitch_path) {
      return res.status(404).json({ error: 'لا يوجد مقطع صوتي متاح لهذا الطلب أو انتهت مدة الاحتفاظ به.' });
    }

    // حظر الاستماع لأي تسجيل منتهي الصلاحية فوراً وتنفيذ التطهير الذري في نفس اللحظة
    if (rows[0].is_retention_expired) {
      await runExpiredVoiceRetentionPurge('system:stream-expiry-guard', 'system', req.ip).catch(() => {});
      return res.status(410).json({
        error: 'انتهت مدة الاحتفاظ القانونية بهذا التسجيل الصوتي (30 يوماً لغير المختارين) وتم حذفه تلقائياً.',
        code: 'VOICE_RETENTION_EXPIRED'
      });
    }

    const diskPath = resolveSafeVoiceDiskPath(rows[0].voice_pitch_path);
    if (!diskPath || !fs.existsSync(diskPath)) {
      return res.status(404).json({ error: 'ملف التسجيل الصوتي غير موجود على الخادم.' });
    }

    const stat = fs.statSync(diskPath);
    const totalSize = stat.size;
    const mimeType = rows[0].voice_mime_type || 'audio/webm';
    const rangeHeader = req.headers.range;

    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // توثيق الاستماع البشري في سجل التدقيق عند بداية البث (بدون تكرار مفرط لطلبات الـ Range اللاحقة)
    if (!rangeHeader || rangeHeader.startsWith('bytes=0-')) {
      await logAudit({
        actor: req.user.full_name,
        actorRole: req.user.role,
        action: 'VOICE_PITCH_PLAYED',
        entityType: 'application',
        entityId: rows[0].reference_no,
        metadata: { mime: mimeType, size_bytes: totalSize },
        ipAddress: req.ip
      });
    }

    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!m) {
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        return res.status(416).end();
      }
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), totalSize - 1) : totalSize - 1;
      if (start >= totalSize || start > end) {
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        return res.status(416).end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.setHeader('Content-Length', end - start + 1);
      res.setHeader('Content-Type', mimeType);
      return fs.createReadStream(diskPath, { start, end }).pipe(res);
    }

    res.status(200);
    res.setHeader('Content-Length', totalSize);
    res.setHeader('Content-Type', mimeType);
    return fs.createReadStream(diskPath).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/applications/:idOrRef/voice-review', requireAuth(['super_admin', 'hr_coordinator', 'committee_member']), async (req, res) => {
  try {
    const { idOrRef } = req.params;
    const isNum = /^\d+$/.test(idOrRef);
    const bonusRaw = Number(req.body?.voice_bonus_score);
    const reviewNotes = String(req.body?.voice_review_notes || '').trim();

    if (Number.isNaN(bonusRaw) || bonusRaw < 0 || bonusRaw > 5) {
      return res.status(400).json({
        error: 'درجة التميز الإضافية للتعريف الصوتي يجب أن تكون بين 0 و 5 درجات كحد أقصى (بدون أي خصم).',
        code: 'INVALID_VOICE_BONUS_SCORE'
      });
    }

    const { rows } = await query(
      `UPDATE applications
       SET voice_bonus_score = $1,
           voice_review_notes = $2,
           voice_reviewed_by = $3,
           voice_reviewed_at = NOW(),
           updated_at = NOW()
       WHERE ${isNum ? 'id = $4' : 'UPPER(reference_no) = UPPER($4)'}
       RETURNING id, reference_no, voice_bonus_score, voice_review_notes, voice_reviewed_by, voice_reviewed_at`,
      [Number(bonusRaw.toFixed(2)), reviewNotes || null, req.user.full_name, isNum ? parseInt(idOrRef, 10) : idOrRef]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'الطلب غير موجود.' });
    }

    await logAudit({
      actor: req.user.full_name,
      actorRole: req.user.role,
      action: 'VOICE_PITCH_REVIEWED',
      entityType: 'application',
      entityId: rows[0].reference_no,
      metadata: {
        voice_bonus_score: Number(rows[0].voice_bonus_score),
        has_notes: Boolean(reviewNotes)
      },
      ipAddress: req.ip
    });

    res.json({
      message: 'تم اعتماد تقييم التعريف الصوتي البشري بنجاح ✓',
      voice_review: rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/system/purge-expired-voice', requireAuth(['super_admin', 'hr_coordinator']), async (req, res) => {
  try {
    const result = await runExpiredVoiceRetentionPurge(req.user.full_name, req.user.role, req.ip);
    res.json({
      message: `اكتملت دورة التطهير التلقائي للمقاطع الصوتية المنتهية (${result.purged_count} ملف).`,
      ...result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      if (req && req.path && req.path.endsWith('/voice-pitch')) {
        return res.status(400).json({ error: 'يتجاوز حجم الملف الصوتي الحد الأقصى المسموح (2.5 ميجابايت).', code: 'VOICE_FILE_TOO_LARGE' });
      }
      return res.status(400).json({ error: `يتجاوز حجم الملف الحد الأقصى المسموح (${MAX_UPLOAD_MB} ميجابايت).` });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'خطأ داخلي في الخادم.' });
});

ensureDatabaseInitialized()
  .then(() => {
    runExpiredVoiceRetentionPurge().catch((e) => console.error('[Voice Janitor] Startup purge error:', e.message));
    const voicePurgeTimer = setInterval(() => {
      runExpiredVoiceRetentionPurge().catch((e) => console.error('[Voice Janitor] Periodic purge error:', e.message));
    }, 6 * 60 * 60 * 1000);
    if (typeof voicePurgeTimer.unref === 'function') voicePurgeTimer.unref();

    app.listen(PORT, HOST, () => {
      console.log(`=============================================================`);
      console.log(`🚀 منصة التوظيف الذكية v${APP_VERSION} تعمل الآن على http://${HOST}:${PORT}`);
      console.log(`🔒 نظام الصلاحيات + استقبال QR + التعريف الصوتي الاختياري مفعّلة`);
      console.log(`=============================================================`);
    });
  })
  .catch((err) => {
    console.error('فشل الاتصال الأولي بقاعدة البيانات:', err.message);
    process.exit(1);
  });
