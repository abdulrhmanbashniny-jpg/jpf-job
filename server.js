require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

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
  createCandidatePortalToken,
  verifyCandidatePortalToken,
  deriveCandidateAccessKey,
  verifyCandidateAccessKey,
  setCandidateCookie,
  extractCandidateTokenFromRequest,
  extractAllCandidateTokensFromRequest,
  verifyScopedToken,
  requireAuth
} = require('./services/auth');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '10', 10);

const uploadsDir = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, 'uploads');
const publicUploadsDir = path.join(uploadsDir, 'public');
if (!fs.existsSync(publicUploadsDir)) {
  fs.mkdirSync(publicUploadsDir, { recursive: true });
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
const PROTECTED_PAGES = new Set([
  '/Dashboard.dc.html',
  '/JobBuilder.dc.html',
  '/CandidateProfile.dc.html',
  '/Ranking.dc.html',
  '/Scheduler.dc.html',
  '/Interviews.dc.html',
  '/AIEngine.dc.html',
  '/Settings.dc.html',
  '/System.dc.html',
  '/Users.dc.html'
]);

app.use((req, res, next) => {
  if (PROTECTED_PAGES.has(req.path)) {
    const session = getSessionFromRequest(req);
    if (!session) {
      const nextTarget = encodeURIComponent(req.originalUrl || req.path);
      return res.redirect(`/Login.dc.html?next=${nextTarget}`);
    }
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

// السماح بعرض صورة مدخل المقر فقط للزوار في بطاقة الوصول الحضورية، مع إبقاء السير الذاتية محمية
app.use('/uploads/public', express.static(publicUploadsDir));

app.use('/uploads', (req, res, next) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.status(401).send('غير مصرح بالوصول إلى ملفات السير الذاتية إلا لأعضاء لجنة التوظيف.');
  }
  next();
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

app.get('/api/auth/me', (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
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

    if (targetId === req.user.uid && is_active === false) {
      return res.status(400).json({ error: 'لا يمكنك إيقاف حسابك الشخصي الحالي.' });
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
      version: '2.1.0',
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

    const safeApplications = rows.map(({ candidate_access_token: _cat, ...row }) => row);
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
    const session = getSessionFromRequest(req);
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

      const [interviewRes, locConfig] = await Promise.all([
        query(
          `SELECT id, visit_token, scheduled_date, start_time, duration_minutes, booking_status, interview_mode
           FROM interviews WHERE application_id = $1`,
          [application.id]
        ),
        getCompanyLocationConfig()
      ]);

      const origin = getBaseOrigin(req);
      const intRow = interviewRes.rows[0] || null;

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

    const { candidate_access_token: _staffHiddenCat, ...safeStaffApp } = application;
    const rawInt = interviewRes.rows[0] || null;
    let safeStaffInt = null;
    if (rawInt) {
      const { visit_token: rawVt, ...restInt } = rawInt;
      safeStaffInt = {
        ...restInt,
        visit_url: buildVisitPassUrl(getBaseOrigin(req), rawInt.id, rawVt)
      };
    }

    res.json({
      application: {
        ...safeStaffApp,
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
        meeting_platform: interview.meeting_platform,
        meeting_url: interview.interview_mode === 'in_person' ? null : interview.meeting_url,
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

app.patch('/api/applications/:id/status', requireAuth(), async (req, res) => {
  try {
    const appId = parseInt(req.params.id, 10);
    const { status } = req.body;
    const { rows } = await query(
      `UPDATE applications SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, appId]
    );
    if (!rows.length) return res.status(404).json({ error: 'الطلب غير موجود.' });

    await logAudit({
      actor: req.user.full_name,
      actorRole: req.user.role,
      action: 'APPLICATION_STATUS_CHANGED',
      entityType: 'application',
      entityId: rows[0].reference_no,
      metadata: { new_status: status },
      ipAddress: req.ip
    });

    res.json({ application: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------------
// 5. اختبار الجدارة غير المتزامن (فوري بلا تعليق + عداد 60 ثانية + استطلاع حي)
// ---------------------------------------------------------------------------------

app.post('/api/assessments/upload-attachment', (req, res, next) => {
  const staff = getSessionFromRequest(req);
  const candTok = extractCandidateTokenFromRequest(req, null);
  const validScoped = candTok ? verifyScopedToken(candTok, 'candidate_portal') : null;
  if (!staff && !validScoped) {
    return res.status(403).json({ error: 'يلزم جلسة متقدم موثقة لرفع مرفقات الاختبار.' });
  }
  next();
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
    const staff = getSessionFromRequest(req);
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

    const staff = getSessionFromRequest(req);
    if (application_id && !staff) {
      return res.status(403).json({ error: 'غير مصرح بإرسال الاختبار بمعرّف داخلي.' });
    }

    const appRes = await client.query(
      `SELECT a.*, c.full_name, c.email, c.phone, c.years_experience, c.qualification, c.specialization,
              c.portfolio_url, c.cv_filename, c.cv_stored_path, c.cv_extracted_text
       FROM applications a
       JOIN candidates c ON c.id = a.candidate_id
       WHERE ${application_id ? 'a.id = $1' : 'UPPER(a.reference_no) = UPPER($1)'}`,
      [application_id ? parseInt(application_id, 10) : reference_no]
    );

    if (!appRes.rows.length) {
      return res.status(403).json({ error: 'غير مصرح بالوصول إلى هذا الطلب.' });
    }
    const appRow = appRes.rows[0];

    if (!staff) {
      const candTok = extractCandidateTokenFromRequest(req, appRow.reference_no);
      if (!verifyCandidatePortalToken(candTok, appRow.reference_no, appRow.candidate_access_token)) {
        return res.status(403).json({ error: 'يلزم التحقق من ملكية الطلب قبل إرسال الاختبار.', code: 'CANDIDATE_VERIFY_REQUIRED' });
      }
      setCandidateCookie(res, req, appRow.reference_no, candTok);
    }
    const locCfg = await getCompanyLocationConfig();

    if (appRow.assessed_at && appRow.status !== 'assessment_pending') {
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

    await client.query('BEGIN');
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
      notes
    } = req.body;

    if (!application_id) {
      return res.status(400).json({ error: 'معرّف الطلب مفقود.' });
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

    const { rows } = await query(
      `INSERT INTO committee_evaluations (
        application_id, evaluator_name, evaluator_role,
        technical_competence, communication_persuasion, problem_solving, cultural_fit, portfolio_practical,
        recommendation, notes
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (application_id, evaluator_name) DO UPDATE SET
        evaluator_role = EXCLUDED.evaluator_role,
        technical_competence = EXCLUDED.technical_competence,
        communication_persuasion = EXCLUDED.communication_persuasion,
        problem_solving = EXCLUDED.problem_solving,
        cultural_fit = EXCLUDED.cultural_fit,
        portfolio_practical = EXCLUDED.portfolio_practical,
        recommendation = EXCLUDED.recommendation,
        notes = EXCLUDED.notes,
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
        notes || ''
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
        c.full_name, c.email, c.phone, c.city, c.years_experience, c.qualification, c.specialization,
        j.id AS job_id, j.code AS job_code, j.title AS job_title, j.department, j.accent_color, j.passing_score,
        (SELECT COUNT(*)::int FROM committee_evaluations ce WHERE ce.application_id = a.id) AS evaluations_count,
        i.id AS interview_id, i.visit_token, i.scheduled_date, i.start_time, i.booking_status, i.interview_mode, i.meeting_url,
        (SELECT wm.id FROM wa_messages wm WHERE wm.interview_id = i.id ORDER BY wm.id DESC LIMIT 1) AS wa_message_id,
        (SELECT wm.queue_status FROM wa_messages wm WHERE wm.interview_id = i.id ORDER BY wm.id DESC LIMIT 1) AS wa_queue_status,
        (SELECT wm.prepared_at FROM wa_messages wm WHERE wm.interview_id = i.id ORDER BY wm.id DESC LIMIT 1) AS wa_prepared_at
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
          (SELECT wm.id FROM wa_messages wm WHERE wm.interview_id = i.id ORDER BY wm.id DESC LIMIT 1) AS wa_message_id,
          (SELECT wm.queue_status FROM wa_messages wm WHERE wm.interview_id = i.id ORDER BY wm.id DESC LIMIT 1) AS wa_status,
          (SELECT wm.wa_link FROM wa_messages wm WHERE wm.interview_id = i.id ORDER BY wm.id DESC LIMIT 1) AS wa_link
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
      visit_url: buildVisitPassUrl(origin, row.id, visit_token)
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
app.post('/api/interviews/schedule-single', requireAuth(['super_admin', 'hr_coordinator', 'committee_member']), async (req, res) => {
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
    } = req.body;

    if (!application_id || !scheduled_date || !start_time) {
      return res.status(400).json({ error: 'يرجى تحديد المرشح وتاريخ ووقت المقابلة.' });
    }

    const candRes = await client.query(
      `SELECT a.id AS application_id, a.reference_no, c.full_name, c.phone, j.code AS job_code, j.title AS job_title
       FROM applications a
       JOIN candidates c ON c.id = a.candidate_id
       JOIN jobs j ON j.id = a.job_id
       WHERE a.id = $1`,
      [parseInt(application_id, 10)]
    );
    if (!candRes.rows.length) {
      return res.status(404).json({ error: 'المرشح المطلوب غير موجود.' });
    }
    const cand = candRes.rows[0];
    const locCfg = await getCompanyLocationConfig();
    const tplRes = await client.query("SELECT setting_value FROM system_settings WHERE setting_key = 'whatsapp_templates'");
    const templates = tplRes.rows[0]?.setting_value || {};

    const dur = Math.max(15, parseInt(duration_minutes, 10) || 30);
    const endStr = minutesToTime(timeToMinutes(start_time) + dur);
    const origin = getBaseOrigin(req);

    const isRemote = interview_mode !== 'in_person';
    const defaultRoom = `https://meet.jit.si/JPF-${cand.job_code.replace(/[^a-zA-Z0-9]/g, '')}-${cand.reference_no.slice(-4)}`;
    const provisionalMeetUrl = isRemote ? (meeting_url && String(meeting_url).trim() ? String(meeting_url).trim() : defaultRoom) : origin;

    const finalBuilding = location_building || locCfg.building_name;
    const finalFloor = location_floor || locCfg.floor_number;
    const finalOffice = location_office || locCfg.office_number;
    const finalMaps = location_maps_url || locCfg.google_maps_url;
    const finalImg = location_image_url || locCfg.entrance_image_url || '/img/hq-entrance.svg';
    const finalNotes = location_notes || locCfg.arrival_instructions;

    await client.query('BEGIN');

    const prevIntRes = await client.query(
      'SELECT id, booking_status FROM interviews WHERE application_id = $1 FOR UPDATE',
      [cand.application_id]
    );
    const isReschedule = prevIntRes.rows.length > 0;
    const freshVisitToken = crypto.randomBytes(32).toString('hex');

    if (isReschedule) {
      // إبطال كافة الدعوات والرسائل السابقة المرتبطة بالموعد القديم قبل إصدار الدعوة الجديدة برمز زيارة جديد
      await client.query(
        `UPDATE wa_messages
         SET queue_status = 'cancelled'
         WHERE interview_id = $1 AND queue_status IN ('queued', 'sent', 'confirmed')`,
        [prevIntRes.rows[0].id]
      );
    }

    // لا يُسجَّل الموعد كـ invitation_sent لمجرد فتح رابط wa.me؛ يبقى scheduled / rescheduled حتى يؤكد الموظف الإرسال الفعلي
    const intIns = await client.query(
      `INSERT INTO interviews (
        application_id, scheduled_date, start_time, end_time, duration_minutes,
        meeting_platform, meeting_url, interviewer_panel, booking_status,
        interview_mode, visit_token, location_building, location_floor, location_office,
        location_maps_url, location_image_url, location_notes, notes
      ) VALUES ($1,$2::date,$3::time,$4::time,$5,$6,$7,$8,'scheduled',$9,$10,$11,$12,$13,$14,$15,$16,$17)
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
        isRemote ? 'مقابلة عن بُعد' : `حضوري: ${finalFloor} - ${finalOffice}`
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
    const duration = Math.max(15, parseInt(slot_duration_minutes, 10) || 30);
    const buffer = Math.max(0, parseInt(buffer_minutes, 10) || 10);
    const isRemote = interview_mode !== 'in_person';
    const origin = getBaseOrigin(req);
    const locCfg = await getCompanyLocationConfig();

    let candidatesQuery = `
      SELECT a.id AS application_id, a.reference_no, c.full_name, c.phone, j.code AS job_code, j.title AS job_title
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
        SELECT a.id AS application_id, a.reference_no, c.full_name, c.phone, j.code AS job_code, j.title AS job_title
        FROM applications a
        JOIN candidates c ON c.id = a.candidate_id
        JOIN jobs j ON j.id = a.job_id
        WHERE a.id = ANY($1::int[])
      `;
    }
    candidatesQuery += ' ORDER BY a.final_weighted_score DESC, a.ai_overall_score DESC';

    const candRes = await client.query(candidatesQuery, params);
    if (!candRes.rows.length) {
      return res.status(400).json({ error: 'لا يوجد مرشحون مؤهلون غير مجدولين حالياً لتوزيع المواعيد عليهم.' });
    }

    const bookedRes = await client.query(
      'SELECT start_time, end_time FROM interviews WHERE scheduled_date = $1',
      [scheduleDate]
    );
    const bookedRanges = bookedRes.rows.map((b) => [
      timeToMinutes(String(b.start_time).slice(0, 5)),
      timeToMinutes(String(b.end_time).slice(0, 5))
    ]);

    const dayStart = timeToMinutes(work_start);
    const dayEnd = timeToMinutes(work_end);
    const prayerStart = timeToMinutes(dhuhr_start);
    const prayerEnd = timeToMinutes(dhuhr_end);

    const tplRes = await client.query("SELECT setting_value FROM system_settings WHERE setting_key = 'whatsapp_templates'");
    const templates = tplRes.rows[0]?.setting_value || {};
    const tplKey = isRemote ? 'interview_invite' : 'interview_inperson';
    const inviteTemplate = templates[tplKey] || 'مرحباً {الاسم}، يسعدنا دعوتك لمقابلة ({الوظيفة}) بتاريخ {موعد_المقابلة}. التفاصيل وتأكيد الحضور: {رابط_الحجز}';

    await client.query('BEGIN');

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
             WHERE interview_id = $1 AND queue_status IN ('queued', 'sent', 'confirmed')`,
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
    const { booking_status, notes, scheduled_date, start_time, end_time, interview_mode } = req.body;

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

    const scheduleChanged =
      (scheduled_date && String(scheduled_date).slice(0, 10) !== curDateStr) ||
      (start_time && String(start_time).slice(0, 5) !== curStartStr) ||
      (end_time && String(end_time).slice(0, 5) !== curEndStr) ||
      (interview_mode && interview_mode !== cur.interview_mode) ||
      booking_status === 'rescheduled';

    const isCancelled = booking_status === 'cancelled';

    // منع تعيين invitation_sent أو confirmed أو تجاوز آلة الحالات يدوياً من مسار تعديل الموعد
    if (booking_status && booking_status !== cur.booking_status && !scheduleChanged) {
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

    const shouldRevokePriorPass = scheduleChanged || isCancelled;
    const nextVisitToken = shouldRevokePriorPass ? crypto.randomBytes(32).toString('hex') : cur.visit_token;
    const effectiveStatus = isCancelled
      ? 'cancelled'
      : scheduleChanged
        ? 'rescheduled'
        : (booking_status || cur.booking_status);

    let effectiveEndTime = end_time || null;
    if (!effectiveEndTime && start_time) {
      effectiveEndTime = minutesToTime(timeToMinutes(start_time) + (Number(cur.duration_minutes) || 30));
    }

    const origin = getBaseOrigin(req);
    const nextMode = interview_mode || cur.interview_mode || 'remote';
    const newVisitUrl = buildVisitPassUrl(origin, id, nextVisitToken);
    const nextMeetingUrl = nextMode === 'in_person' ? newVisitUrl : cur.meeting_url;

    const { rows } = await client.query(
      `UPDATE interviews SET
        booking_status = $1,
        notes = COALESCE($2, notes),
        scheduled_date = COALESCE($3::date, scheduled_date),
        start_time = COALESCE($4::time, start_time),
        end_time = COALESCE($5::time, end_time),
        interview_mode = $6,
        visit_token = $7,
        meeting_url = $8,
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
        id
      ]
    );

    let replacementWaMessage = null;
    if (shouldRevokePriorPass) {
      // إبطال كافة الدعوات والرسائل السابقة المرتبطة بالموعد القديم أو الملغى
      await client.query(
        `UPDATE wa_messages
         SET queue_status = 'cancelled'
         WHERE interview_id = $1 AND queue_status IN ('queued', 'sent', 'confirmed')`,
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

app.post('/api/wa-messages', requireAuth(['super_admin', 'hr_coordinator', 'committee_member']), async (req, res) => {
  try {
    const { application_id, interview_id, recipient_name, recipient_phone, message_body, template_key = 'custom', open_draft = false } = req.body;
    if (template_key === 'portal_recovery' && !['super_admin', 'hr_coordinator'].includes(req.user.role)) {
      return res.status(403).json({
        error: 'صلاحية رسائل استعادة دخول المتقدمين محصورة بالمدير والموارد البشرية.',
        code: 'FORBIDDEN_ROLE'
      });
    }
    if (!recipient_name || !recipient_phone || !message_body) {
      return res.status(400).json({ error: 'اسم المستلم ورقم الجوال ونص الرسالة مطلوبة.' });
    }
    const cleanPhone = normalizePhoneForWa(recipient_phone);
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

app.patch('/api/wa-messages/:id', requireAuth(['super_admin', 'hr_coordinator', 'committee_member']), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { action, queue_status, message_body } = req.body;
    const actorName = req.user.full_name;

    const existing = await query('SELECT * FROM wa_messages WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'الرسالة غير موجودة في الطابور.' });

    const current = existing.rows[0];
    if (current.template_key === 'portal_recovery' && !['super_admin', 'hr_coordinator'].includes(req.user.role)) {
      return res.status(403).json({
        error: 'حساب عضو اللجنة غير مخوّل بالاطلاع على أسرار وروابط استعادة المتقدمين أو تعديلها.',
        code: 'FORBIDDEN_ROLE'
      });
    }

    if (current.queue_status === 'cancelled' && queue_status !== 'cancelled') {
      return res.status(400).json({
        error: 'هذه الرسالة ملغاة بسبب تحديث أو إلغاء الموعد؛ يرجى استخدام الرسالة المحدّثة الجديدة.',
        code: 'WA_MESSAGE_CANCELLED'
      });
    }

    // حماية نص رسائل portal_recovery من أي استبدال بقالب آخر للحفاظ على رابط الاستعادة والمفتاح السري المولّدين
    const updatedBody =
      current.template_key === 'portal_recovery'
        ? current.message_body
        : (message_body !== undefined ? message_body : current.message_body);
    const updatedLink = buildWaLink(current.recipient_phone, updatedBody);

    // 1. فتح رابط wa.me كمسودة لا يُسجّل الرسالة كـ sent؛ يحدّث prepared_at فقط وتبقى queued («بانتظار تأكيد الإرسال»)
    if (action === 'open_draft') {
      const { rows } = await query(
        `UPDATE wa_messages SET
          message_body = $1,
          wa_link = $2,
          prepared_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [updatedBody, updatedLink, id]
      );

      await logAudit({
        actor: actorName,
        actorRole: req.user.role,
        action: 'WA_DRAFT_OPENED',
        entityType: 'wa_message',
        entityId: id,
        metadata: { recipient: current.recipient_name, queue_status: rows[0].queue_status },
        ipAddress: req.ip
      });

      return res.json({ message: rows[0] });
    }

    // 2. التأكيد الفعلي من الموظف بعد إرسال الرسالة فعلياً داخل واتساب
    const updatedStatus = action === 'confirm_sent' ? 'sent' : (queue_status || current.queue_status);

    // منع الانتقال المباشر من queued (غير مرسلة) إلى confirmed دون تأكيد إرسال الدعوة أولاً
    if (updatedStatus === 'confirmed' && current.queue_status === 'queued') {
      return res.status(400).json({
        error: 'لا يمكن تسجيل تأكيد حضور على رسالة ما زالت في الطابور (queued) ولم يتأكد إرسالها بعد.',
        code: 'CANNOT_CONFIRM_UNSENT_MESSAGE'
      });
    }

    const { rows } = await query(
      `UPDATE wa_messages SET
        message_body = $1,
        wa_link = $2,
        queue_status = $3::varchar,
        sent_by = CASE WHEN $3::varchar IN ('sent','confirmed') THEN $4 ELSE sent_by END,
        sent_at = CASE WHEN $3::varchar = 'sent' AND sent_at IS NULL THEN NOW() ELSE sent_at END
      WHERE id = $5
      RETURNING *`,
      [updatedBody, updatedLink, updatedStatus, actorName, id]
    );

    if (current.interview_id && updatedStatus === 'sent') {
      await query(
        `UPDATE interviews SET booking_status = 'invitation_sent', updated_at = NOW()
         WHERE id = $1 AND booking_status IN ('scheduled', 'rescheduled')`,
        [current.interview_id]
      );
    } else if (current.interview_id && updatedStatus === 'confirmed') {
      await query(
        `UPDATE interviews SET booking_status = 'confirmed', updated_at = NOW() WHERE id = $1`,
        [current.interview_id]
      );
    }

    await logAudit({
      actor: actorName,
      actorRole: req.user.role,
      action: updatedStatus === 'sent' ? 'WA_SEND_CONFIRMED' : 'WA_MESSAGE_UPDATED',
      entityType: 'wa_message',
      entityId: id,
      metadata: { status: updatedStatus, recipient: current.recipient_name },
      ipAddress: req.ip
    });

    res.json({ message: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
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
    app.listen(PORT, HOST, () => {
      console.log(`=============================================================`);
      console.log(`🚀 منصة التوظيف الذكية v2.1 تعمل الآن على http://${HOST}:${PORT}`);
      console.log(`🔒 نظام الصلاحيات + العداد الذكي 60s + بطاقة الزيارة مفعّلة`);
      console.log(`=============================================================`);
    });
  })
  .catch((err) => {
    console.error('فشل الاتصال الأولي بقاعدة البيانات:', err.message);
    process.exit(1);
  });
