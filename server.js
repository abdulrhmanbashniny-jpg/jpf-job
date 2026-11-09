require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

const { pool, query, ensureDatabaseInitialized, logAudit } = require('./database/db');
const { evaluateSubmission, anonymizeText, getProvidersEnvStatus } = require('./services/aiEvaluator');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '10', 10);

// إعداد مجلد المرفقات الآمن
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ترويسات أمان قياسية دون حظر المعاينة المضمنة
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// تحديد معدل الطلبات لحماية الخادم في الإنتاج
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'تم تجاوز الحد المسموح للطلبات، يرجى المحاولة بعد قليل.' }
});
app.use('/api/', apiLimiter);

// إعداد رفع الملفات (السير الذاتية ومرفقات الاختبار)
const allowedExtensions = new Set(['.pdf', '.docx', '.doc', '.png', '.jpg', '.jpeg']);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeTag = crypto.randomBytes(6).toString('hex');
    cb(null, `${Date.now()}-${safeTag}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!allowedExtensions.has(ext)) {
      return cb(new Error('صيغة الملف غير مدعومة. الصيغ المسموحة: PDF, DOCX, PNG, JPG'));
    }
    cb(null, true);
  }
});

// تقديم ملفات المرفقات وملفات الواجهة الثابتة
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------------
// دوال مساعدة
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

// ---------------------------------------------------------------------------------
// 1. فحص جاهزية الخادم ومعمارية النظام (Health & Architecture)
// ---------------------------------------------------------------------------------

app.get('/api/health', async (_req, res) => {
  const start = Date.now();
  try {
    const dbRes = await query(`
      SELECT
        version() AS pg_version,
        current_database() AS db_name,
        (SELECT COUNT(*)::int FROM information_schema.tables WHERE table_schema = 'public') AS tables_count,
        (SELECT COUNT(*)::int FROM jobs WHERE is_active = TRUE) AS active_jobs,
        (SELECT COUNT(*)::int FROM applications) AS total_applications
    `);
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      latency_ms: Date.now() - start,
      node_version: process.version,
      database: dbRes.rows[0],
      ai_providers: getProvidersEnvStatus(),
      security: {
        browser_secrets_stored: false,
        env_managed: true
      }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/system/architecture', async (_req, res) => {
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

// ---------------------------------------------------------------------------------
// 2. مسارات الوظائف وبنك الأسئلة (Jobs & JobBuilder)
// ---------------------------------------------------------------------------------

app.get('/api/jobs', async (req, res) => {
  try {
    const { department, search, include_inactive, mode } = req.query;
    const params = [];
    const where = [];

    if (include_inactive !== '1') {
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
      passing_score: Number(job.passing_score),
      questions_count: Array.isArray(job.questions) ? job.questions.length : 10,
      questions: mode === 'committee' ? job.questions : sanitizeQuestionsForCandidate(job.questions)
    }));

    res.json({ jobs: formatted });
  } catch (err) {
    res.status(500).json({ error: 'تعذر جلب قائمة الوظائف: ' + err.message });
  }
});

app.get('/api/jobs/:idOrCode', async (req, res) => {
  try {
    const { idOrCode } = req.params;
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
    const isCommittee = req.query.mode === 'committee';
    res.json({
      job: {
        ...job,
        passing_score: Number(job.passing_score),
        questions: isCommittee ? job.questions : sanitizeQuestionsForCandidate(job.questions)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// توليد 10 أسئلة تخصصية تلقائياً في صفحة JobBuilder
app.post('/api/jobs/generate-questions', async (req, res) => {
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

app.post('/api/jobs', async (req, res) => {
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
      actor: 'لجنة التوظيف',
      actorRole: 'committee',
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

app.put('/api/jobs/:id', async (req, res) => {
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
      actor: 'لجنة التوظيف',
      actorRole: 'committee',
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
// 3. التقديم ورفع السيرة الذاتية (POST /api/applications)
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

    const jobRes = await client.query('SELECT * FROM jobs WHERE id = $1 AND is_active = TRUE', [parseInt(job_id, 10)]);
    if (!jobRes.rows.length) {
      return res.status(404).json({ error: 'الوظيفة المختارة غير متاحة حالياً للتقديم.' });
    }
    const job = jobRes.rows[0];

    const storedPath = `/uploads/${req.file.filename}`;
    const extracted = `${cv_summary_notes || ''} ${extractReadableTextFromUpload(req.file.path, req.file.originalname)}`.trim();

    await client.query('BEGIN');

    // البحث عن سجل المرشح بالبريد أو الجوال لمنع تكرار السجلات
    const existingCand = await client.query(
      'SELECT * FROM candidates WHERE LOWER(email) = $1 OR phone = $2 LIMIT 1',
      [cleanEmail, cleanPhone]
    );

    let candidateId;
    if (existingCand.rows.length > 0) {
      candidateId = existingCand.rows[0].id;

      // التحقق مما إذا كان قد تقدم مسبقاً لنفس الوظيفة
      const dupApp = await client.query(
        'SELECT reference_no, status FROM applications WHERE job_id = $1 AND candidate_id = $2',
        [job.id, candidateId]
      );
      if (dupApp.rows.length > 0) {
        await client.query('ROLLBACK');
        const existingApp = dupApp.rows[0];
        if (existingApp.status === 'assessment_pending') {
          return res.status(200).json({
            resumed: true,
            message: 'لديك طلب مسجل بانتظار استكمال اختبار الجدارة، جاري نقلك للاختبار.',
            reference_no: existingApp.reference_no
          });
        }
        return res.status(409).json({
          error: `لقد قمت بالتقديم مسبقاً على هذه الوظيفة برقم مرجعي (${existingApp.reference_no}). يمنع النظام تكرار الطلبات لنفس الوظيفة.`
        });
      }

      // تحديث بيانات المرشح لأحدث سيرة ذاتية
      await client.query(
        `UPDATE candidates SET
          full_name = $1,
          city = $2,
          years_experience = $3,
          qualification = $4,
          portfolio_url = COALESCE($5, portfolio_url),
          cv_filename = $6,
          cv_stored_path = $7,
          cv_extracted_text = $8,
          updated_at = NOW()
        WHERE id = $9`,
        [
          String(full_name).trim(),
          city || 'جدة',
          Math.max(0, parseFloat(years_experience || '0') || 0),
          qualification || 'بكالوريوس',
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
          full_name, email, phone, city, years_experience, qualification,
          portfolio_url, cv_filename, cv_stored_path, cv_extracted_text
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id`,
        [
          String(full_name).trim(),
          cleanEmail,
          cleanPhone,
          city || 'جدة',
          Math.max(0, parseFloat(years_experience || '0') || 0),
          qualification || 'بكالوريوس',
          portfolio_url || null,
          req.file.originalname,
          storedPath,
          extracted
        ]
      );
      candidateId = insCand.rows[0].id;
    }

    // توليد رقم طلب مرجعي فريد
    const seqRes = await client.query('SELECT COALESCE(MAX(id), 0) + 1001 AS next_num FROM applications');
    const refNo = `APP-2026-${seqRes.rows[0].next_num}`;

    const appIns = await client.query(
      `INSERT INTO applications (reference_no, job_id, candidate_id, status, privacy_consent)
       VALUES ($1, $2, $3, 'assessment_pending', TRUE)
       RETURNING *`,
      [refNo, job.id, candidateId]
    );

    await client.query('COMMIT');

    await logAudit({
      actor: String(full_name).trim(),
      actorRole: 'candidate',
      action: 'APPLICATION_SUBMITTED',
      entityType: 'application',
      entityId: refNo,
      metadata: { job_code: job.code, city: city || 'جدة', cv: req.file.originalname },
      ipAddress: req.ip
    });

    res.status(201).json({
      message: 'تم حفظ بيانات التقديم والسيرة الذاتية بنجاح.',
      application: appIns.rows[0],
      reference_no: refNo,
      job: { id: job.id, code: job.code, title: job.title, duration_minutes: job.duration_minutes }
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'حدث خطأ أثناء حفظ الطلب: ' + err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------------
// 4. جلب بيانات الطلبات (Applications List & Profile)
// ---------------------------------------------------------------------------------

app.get('/api/applications', async (req, res) => {
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
        c.full_name, c.email, c.phone, c.city, c.years_experience, c.qualification, c.cv_filename, c.cv_stored_path,
        j.code AS job_code, j.title AS job_title, j.department, j.accent_color, j.passing_score,
        i.scheduled_date, i.start_time, i.meeting_url, i.booking_status,
        (SELECT COUNT(*)::int FROM committee_evaluations ce WHERE ce.application_id = a.id) AS evaluations_count
      FROM applications a
      JOIN candidates c ON c.id = a.candidate_id
      JOIN jobs j ON j.id = a.job_id
      LEFT JOIN interviews i ON i.application_id = a.id
      ${whereSql}
      ORDER BY a.final_weighted_score DESC, a.submitted_at DESC`,
      params
    );

    res.json({ applications: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/applications/:idOrRef', async (req, res) => {
  try {
    const { idOrRef } = req.params;
    const isNum = /^\d+$/.test(idOrRef);
    const appRes = await query(
      `SELECT
        a.*,
        c.full_name, c.email, c.phone, c.city, c.years_experience, c.qualification,
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
      return res.status(404).json({ error: 'لم يتم العثور على الطلب المطلوب.' });
    }

    const application = appRes.rows[0];
    const isCommittee = req.query.mode === 'committee';

    const [answersRes, evalsRes, interviewRes] = await Promise.all([
      query('SELECT * FROM assessment_answers WHERE application_id = $1 ORDER BY question_index ASC', [application.id]),
      query('SELECT * FROM committee_evaluations WHERE application_id = $1 ORDER BY evaluated_at DESC', [application.id]),
      query('SELECT * FROM interviews WHERE application_id = $1', [application.id])
    ]);

    res.json({
      application: {
        ...application,
        job_questions: isCommittee
          ? application.job_questions
          : sanitizeQuestionsForCandidate(application.job_questions)
      },
      answers: answersRes.rows,
      evaluations: evalsRes.rows,
      interview: interviewRes.rows[0] || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/applications/:id/status', async (req, res) => {
  try {
    const appId = parseInt(req.params.id, 10);
    const { status, actor = 'لجنة التوظيف' } = req.body;
    const { rows } = await query(
      `UPDATE applications SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, appId]
    );
    if (!rows.length) return res.status(404).json({ error: 'الطلب غير موجود.' });

    await logAudit({
      actor,
      actorRole: 'committee',
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
// 5. اختبار الجدارة التفاعلي وتقييم الذكاء الاصطناعي (POST /api/assessments/submit)
// ---------------------------------------------------------------------------------

app.post('/api/assessments/upload-attachment', upload.single('attachment_file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'لم يتم اختيار ملف صالح.' });
  }
  res.json({
    attachment_path: `/uploads/${req.file.filename}`,
    original_name: req.file.originalname,
    size_kb: Math.round(req.file.size / 1024)
  });
});

app.post('/api/assessments/submit', async (req, res) => {
  const client = await pool.connect();
  try {
    const { reference_no, application_id, answers = [], telemetry = {} } = req.body;
    if (!reference_no && !application_id) {
      return res.status(400).json({ error: 'معرّف الطلب مفقود.' });
    }

    const appRes = await client.query(
      `SELECT a.*, c.full_name, c.email, c.phone, c.years_experience, c.qualification,
              c.portfolio_url, c.cv_filename, c.cv_stored_path, c.cv_extracted_text
       FROM applications a
       JOIN candidates c ON c.id = a.candidate_id
       WHERE ${application_id ? 'a.id = $1' : 'UPPER(a.reference_no) = UPPER($1)'}`,
      [application_id ? parseInt(application_id, 10) : reference_no]
    );

    if (!appRes.rows.length) {
      return res.status(404).json({ error: 'الطلب غير موجود.' });
    }
    const appRow = appRes.rows[0];

    if (appRow.assessed_at && appRow.status !== 'assessment_pending') {
      const alreadyPassed = Number(appRow.assessment_score) >= 60;
      return res.status(200).json({
        already_submitted: true,
        reference_no: appRow.reference_no,
        assessment_score: Number(appRow.assessment_score),
        ai_overall_score: Number(appRow.ai_overall_score),
        passed: alreadyPassed,
        redirect_url: `${alreadyPassed ? 'ResultPass.dc.html' : 'ResultFail.dc.html'}?ref=${encodeURIComponent(appRow.reference_no)}`
      });
    }

    const jobRes = await client.query('SELECT * FROM jobs WHERE id = $1', [appRow.job_id]);
    const job = jobRes.rows[0];

    const settingsRes = await client.query("SELECT setting_value FROM system_settings WHERE setting_key = 'ai_engine_config'");
    const aiConfig = settingsRes.rows[0]?.setting_value || {};

    const evaluation = await evaluateSubmission({
      job,
      candidate: appRow,
      answers,
      telemetry,
      aiConfig
    });

    const newStatus = evaluation.passed ? 'passed_assessment' : 'failed_assessment';
    const timeSpent = Math.max(0, parseInt(telemetry.time_spent_seconds || 0, 10) || 0);
    const tabSwitches = Math.max(0, parseInt(telemetry.tab_switches || 0, 10) || 0);
    const pasteAttempts = Math.max(0, parseInt(telemetry.paste_attempts || 0, 10) || 0);

    await client.query('BEGIN');

    await client.query('DELETE FROM assessment_answers WHERE application_id = $1', [appRow.id]);

    for (const item of evaluation.gradedItems) {
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
        assessed_at = NOW(),
        updated_at = NOW()
      WHERE id = $10`,
      [
        newStatus,
        evaluation.cvMatchScore,
        evaluation.assessmentScore,
        evaluation.aiOverallScore,
        evaluation.integrityScore,
        tabSwitches,
        pasteAttempts,
        timeSpent,
        JSON.stringify(evaluation.aiReport),
        appRow.id
      ]
    );

    await client.query('SELECT fn_sync_application_weighted_score($1)', [appRow.id]);
    await client.query('COMMIT');

    await logAudit({
      actor: 'محرك التحليل الذكي',
      actorRole: 'ai_engine',
      action: 'ASSESSMENT_SUBMITTED_AND_GRADED',
      entityType: 'application',
      entityId: appRow.reference_no,
      metadata: {
        job_code: job.code,
        assessment_score: evaluation.assessmentScore,
        ai_overall_score: evaluation.aiOverallScore,
        integrity_score: evaluation.integrityScore,
        passed: evaluation.passed
      },
      ipAddress: req.ip
    });

    res.json({
      message: 'تم تصحيح الاختبار وإصدار التقرير الفوري بنجاح.',
      reference_no: appRow.reference_no,
      passed: evaluation.passed,
      passing_score: Number(job.passing_score),
      assessment_score: evaluation.assessmentScore,
      cv_match_score: evaluation.cvMatchScore,
      ai_overall_score: evaluation.aiOverallScore,
      integrity_score: evaluation.integrityScore,
      ai_report: evaluation.aiReport,
      redirect_url: `${evaluation.passed ? 'ResultPass.dc.html' : 'ResultFail.dc.html'}?ref=${encodeURIComponent(appRow.reference_no)}`
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'تعذر معالجة إجابات الاختبار: ' + err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------------
// 6. إحصائيات لوحة التحكم المركزية (GET /api/stats)
// ---------------------------------------------------------------------------------

app.get('/api/stats', async (_req, res) => {
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
        c.full_name, c.city,
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
      kpis: {
        ...kpi,
        pass_rate: passRate
      },
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
// 7. تقييم لجنة التوظيف والترتيب الموزون (Evaluations & Ranking)
// ---------------------------------------------------------------------------------

app.post('/api/evaluations', async (req, res) => {
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

    if (!application_id || !evaluator_name) {
      return res.status(400).json({ error: 'بيانات الطلب أو اسم المقيّم مفقودة.' });
    }

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
        String(evaluator_name).trim(),
        evaluator_role || 'عضو لجنة التوظيف',
        scores[0],
        scores[1],
        scores[2],
        scores[3],
        scores[4],
        recommendation || 'hire',
        notes || ''
      ]
    );

    // تحديث حالة الطلب إذا كانت passed_assessment إلى under_review
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
      actor: String(evaluator_name).trim(),
      actorRole: evaluator_role || 'committee',
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

app.get('/api/ranking', async (req, res) => {
  try {
    const { job_id } = req.query;
    const weightsRes = await query("SELECT setting_value FROM system_settings WHERE setting_key = 'ranking_weights'");
    const weights = weightsRes.rows[0]?.setting_value || { ai_weight: 40, committee_weight: 60 };

    const aiWeight = req.query.ai_weight !== undefined ? Number(req.query.ai_weight) : Number(weights.ai_weight ?? 40);
    const commWeight = Number((100 - aiWeight).toFixed(2));

    const params = [];
    let filterSql = "WHERE a.status != 'assessment_pending'";
    if (job_id && job_id !== 'all') {
      params.push(parseInt(job_id, 10));
      filterSql += ` AND a.job_id = $${params.length}`;
    }

    const { rows } = await query(
      `SELECT
        a.id, a.reference_no, a.status, a.cv_match_score, a.assessment_score,
        a.ai_overall_score, a.committee_avg_score, a.final_weighted_score, a.integrity_score,
        c.full_name, c.email, c.phone, c.city, c.years_experience, c.qualification,
        j.id AS job_id, j.code AS job_code, j.title AS job_title, j.department, j.accent_color,
        (SELECT COUNT(*)::int FROM committee_evaluations ce WHERE ce.application_id = a.id) AS evaluations_count,
        i.scheduled_date, i.start_time, i.booking_status
      FROM applications a
      JOIN candidates c ON c.id = a.candidate_id
      JOIN jobs j ON j.id = a.job_id
      LEFT JOIN interviews i ON i.application_id = a.id
      ${filterSql}`,
      params
    );

    const computed = rows.map((r) => {
      const ai = Number(r.ai_overall_score || 0);
      const comm = Number(r.committee_avg_score || 0);
      const dynamicScore = r.evaluations_count > 0
        ? Number(((ai * (aiWeight / 100)) + (comm * (commWeight / 100))).toFixed(2))
        : Number((ai * (aiWeight / 100)).toFixed(2));
      return {
        ...r,
        computed_weighted_score: dynamicScore
      };
    }).sort((a, b) => b.computed_weighted_score - a.computed_weighted_score);

    res.json({
      weights: { ai_weight: aiWeight, committee_weight: commWeight },
      saved_weights: weights,
      ranked_candidates: computed.map((item, idx) => ({ ...item, rank: idx + 1 }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/ranking/weights', async (req, res) => {
  try {
    const aiWeight = Math.max(0, Math.min(100, Number(req.body.ai_weight ?? 40)));
    const committeeWeight = Number((100 - aiWeight).toFixed(2));

    await query(
      `UPDATE system_settings
       SET setting_value = $1::jsonb, updated_by = 'لجنة التوظيف', updated_at = NOW()
       WHERE setting_key = 'ranking_weights'`,
      [JSON.stringify({ ai_weight: aiWeight, committee_weight: committeeWeight, passing_threshold: 60 })]
    );

    // إعادة حساب جميع الدرجات الموزونة في قاعدة البيانات فوراً
    await query('SELECT fn_sync_application_weighted_score(id) FROM applications');

    await logAudit({
      actor: 'رئيس لجنة التوظيف',
      actorRole: 'committee_lead',
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
// 8. جدولة المقابلات الذكية واستثناء صلاة الظهر (Scheduler & Google Meet)
// ---------------------------------------------------------------------------------

app.get('/api/interviews', async (req, res) => {
  try {
    const { date } = req.query;
    const params = [];
    let whereSql = '';
    if (date) {
      params.push(date);
      whereSql = 'WHERE i.scheduled_date = $1';
    }

    const { rows } = await query(
      `SELECT
        i.*,
        a.reference_no, a.final_weighted_score, a.ai_overall_score, a.committee_avg_score, a.status AS app_status,
        c.full_name, c.phone, c.email, c.city,
        j.code AS job_code, j.title AS job_title, j.department, j.accent_color,
        (SELECT wm.id FROM wa_messages wm WHERE wm.interview_id = i.id ORDER BY wm.id DESC LIMIT 1) AS wa_message_id,
        (SELECT wm.queue_status FROM wa_messages wm WHERE wm.interview_id = i.id ORDER BY wm.id DESC LIMIT 1) AS wa_status
      FROM interviews i
      JOIN applications a ON a.id = i.application_id
      JOIN candidates c ON c.id = a.candidate_id
      JOIN jobs j ON j.id = a.job_id
      ${whereSql}
      ORDER BY i.scheduled_date ASC, i.start_time ASC`,
      params
    );

    const eligibleRes = await query(`
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
    `);

    res.json({
      interviews: rows,
      unscheduled_qualified: eligibleRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/interviews/auto-schedule', async (req, res) => {
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
      interviewer_panel = 'لجنة التوظيف والاختيار المركزية',
      application_ids
    } = req.body;

    const scheduleDate = target_date || new Date().toISOString().slice(0, 10);
    const duration = Math.max(15, parseInt(slot_duration_minutes, 10) || 30);
    const buffer = Math.max(0, parseInt(buffer_minutes, 10) || 10);

    // جلب المرشحين المؤهلين غير المجدولين (أو المحددين من المستخدم)
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

    // جلب المواعيد المحجوزة مسبقاً في نفس التاريخ لمنع التعارض
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

    // جلب قالب واتساب من الإعدادات
    const tplRes = await client.query("SELECT setting_value FROM system_settings WHERE setting_key = 'whatsapp_templates'");
    const inviteTemplate = tplRes.rows[0]?.setting_value?.interview_invite ||
      'السلام عليكم أ. {{name}}، يسعدنا دعوتك لمقابلة وظيفة ({{job_title}} - {{job_code}}) بتاريخ {{date}} الساعة {{time}} عبر Google Meet: {{meet_url}}';

    await client.query('BEGIN');

    let cursor = dayStart;
    const scheduled = [];

    for (const cand of candRes.rows) {
      let slotFound = false;
      while (cursor + duration <= dayEnd) {
        const slotStart = cursor;
        const slotEnd = cursor + duration;

        // تخطي استراحة صلاة الظهر تلقائياً
        if (exclude_dhuhr && slotStart < prayerEnd && slotEnd > prayerStart) {
          cursor = prayerEnd;
          continue;
        }

        // تخطي المواعيد المحجوزة مسبقاً
        const conflict = bookedRanges.some(([bStart, bEnd]) => slotStart < bEnd && slotEnd > bStart);
        if (conflict) {
          cursor += 15;
          continue;
        }

        const startStr = minutesToTime(slotStart);
        const endStr = minutesToTime(slotEnd);
        const roomSlug = `ruw-${cand.job_code.toLowerCase().replace(/[^a-z0-9]/g, '')}-${crypto.randomBytes(2).toString('hex')}`;
        const meetUrl = `https://meet.google.com/${roomSlug}`;

        const intIns = await client.query(
          `INSERT INTO interviews (
            application_id, scheduled_date, start_time, end_time, duration_minutes,
            meeting_platform, meeting_url, interviewer_panel, booking_status, notes
          ) VALUES ($1,$2,$3::time,$4::time,$5,'Google Meet',$6,$7,'scheduled','جدولة تلقائية ذكية')
          ON CONFLICT (application_id) DO UPDATE SET
            scheduled_date = EXCLUDED.scheduled_date,
            start_time = EXCLUDED.start_time,
            end_time = EXCLUDED.end_time,
            duration_minutes = EXCLUDED.duration_minutes,
            meeting_url = EXCLUDED.meeting_url,
            interviewer_panel = EXCLUDED.interviewer_panel,
            booking_status = 'rescheduled',
            updated_at = NOW()
          RETURNING *`,
          [cand.application_id, scheduleDate, startStr, endStr, duration, meetUrl, interviewer_panel]
        );

        await client.query(
          "UPDATE applications SET status = 'interview_scheduled', updated_at = NOW() WHERE id = $1",
          [cand.application_id]
        );

        const msgBody = inviteTemplate
          .replace(/\{\{name\}\}/g, cand.full_name)
          .replace(/\{\{job_title\}\}/g, cand.job_title)
          .replace(/\{\{job_code\}\}/g, cand.job_code)
          .replace(/\{\{date\}\}/g, scheduleDate)
          .replace(/\{\{time\}\}/g, startStr)
          .replace(/\{\{meet_url\}\}/g, meetUrl);

        const waLink = buildWaLink(cand.phone, msgBody);

        await client.query(
          `INSERT INTO wa_messages (
            application_id, interview_id, template_key, recipient_name, recipient_phone,
            message_body, wa_link, queue_status
          ) VALUES ($1,$2,'interview_invite',$3,$4,$5,$6,'queued')`,
          [cand.application_id, intIns.rows[0].id, cand.full_name, normalizePhoneForWa(cand.phone), msgBody, waLink]
        );

        bookedRanges.push([slotStart, slotEnd]);
        scheduled.push({
          ...intIns.rows[0],
          full_name: cand.full_name,
          job_code: cand.job_code,
          job_title: cand.job_title,
          wa_link: waLink
        });

        cursor = slotEnd + buffer;
        slotFound = true;
        break;
      }

      if (!slotFound) break;
    }

    // حفظ تفضيلات الجدولة في الإعدادات
    await client.query(
      `UPDATE system_settings SET setting_value = $1::jsonb, updated_at = NOW() WHERE setting_key = 'scheduler_config'`,
      [JSON.stringify({
        work_start,
        work_end,
        slot_duration_minutes: duration,
        buffer_minutes: buffer,
        dhuhr_break_start: dhuhr_start,
        dhuhr_break_end: dhuhr_end,
        default_platform: 'Google Meet',
        panel_name: interviewer_panel
      })]
    );

    await client.query('COMMIT');

    await logAudit({
      actor: 'منسق المقابلات',
      actorRole: 'committee',
      action: 'AUTO_SCHEDULE_EXECUTED',
      entityType: 'interviews',
      entityId: scheduleDate,
      metadata: { scheduled_count: scheduled.length, exclude_dhuhr },
      ipAddress: req.ip
    });

    res.status(201).json({
      message: `تمت جدولة ${scheduled.length} مقابلة وتوليد روابط Google Meet وطابور رسائل واتساب بنجاح.`,
      scheduled
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.patch('/api/interviews/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { booking_status, notes, scheduled_date, start_time, end_time } = req.body;
    const { rows } = await query(
      `UPDATE interviews SET
        booking_status = COALESCE($1, booking_status),
        notes = COALESCE($2, notes),
        scheduled_date = COALESCE($3::date, scheduled_date),
        start_time = COALESCE($4::time, start_time),
        end_time = COALESCE($5::time, end_time),
        updated_at = NOW()
      WHERE id = $6
      RETURNING *`,
      [booking_status || null, notes || null, scheduled_date || null, start_time || null, end_time || null, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'الموعد غير موجود.' });

    if (booking_status === 'completed') {
      await query("UPDATE applications SET status = 'interviewed', updated_at = NOW() WHERE id = $1", [rows[0].application_id]);
    }

    res.json({ interview: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------------
// 9. طابور رسائل واتساب الهجين (Hybrid wa.me Queue)
// ---------------------------------------------------------------------------------

app.get('/api/wa-messages', async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let whereSql = '';
    if (status && status !== 'all') {
      params.push(status);
      whereSql = 'WHERE wm.queue_status = $1';
    }

    const { rows } = await query(
      `SELECT
        wm.*,
        a.reference_no,
        j.code AS job_code, j.title AS job_title, j.accent_color,
        i.scheduled_date, i.start_time, i.meeting_url, i.booking_status
      FROM wa_messages wm
      LEFT JOIN applications a ON a.id = wm.application_id
      LEFT JOIN jobs j ON j.id = a.job_id
      LEFT JOIN interviews i ON i.id = wm.interview_id
      ${whereSql}
      ORDER BY
        CASE wm.queue_status WHEN 'queued' THEN 1 WHEN 'sent' THEN 2 ELSE 3 END,
        wm.created_at DESC`,
      params
    );

    res.json({ messages: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wa-messages', async (req, res) => {
  try {
    const { application_id, recipient_name, recipient_phone, message_body, template_key = 'custom' } = req.body;
    if (!recipient_name || !recipient_phone || !message_body) {
      return res.status(400).json({ error: 'اسم المستلم ورقم الجوال ونص الرسالة مطلوبة.' });
    }
    const cleanPhone = normalizePhoneForWa(recipient_phone);
    const waLink = buildWaLink(cleanPhone, message_body);

    const { rows } = await query(
      `INSERT INTO wa_messages (application_id, template_key, recipient_name, recipient_phone, message_body, wa_link, queue_status)
       VALUES ($1,$2,$3,$4,$5,$6,'queued')
       RETURNING *`,
      [application_id ? parseInt(application_id, 10) : null, template_key, recipient_name, cleanPhone, message_body, waLink]
    );
    res.status(201).json({ message: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/wa-messages/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { queue_status, message_body, sent_by = 'منسق الاستقطاب' } = req.body;

    const existing = await query('SELECT * FROM wa_messages WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'الرسالة غير موجودة في الطابور.' });

    const current = existing.rows[0];
    const updatedBody = message_body !== undefined ? message_body : current.message_body;
    const updatedLink = buildWaLink(current.recipient_phone, updatedBody);
    const updatedStatus = queue_status || current.queue_status;

    const { rows } = await query(
      `UPDATE wa_messages SET
        message_body = $1,
        wa_link = $2,
        queue_status = $3,
        sent_by = CASE WHEN $3 IN ('sent','confirmed') THEN $4 ELSE sent_by END,
        sent_at = CASE WHEN $3 = 'sent' AND sent_at IS NULL THEN NOW() ELSE sent_at END
      WHERE id = $5
      RETURNING *`,
      [updatedBody, updatedLink, updatedStatus, sent_by, id]
    );

    if (current.interview_id && (updatedStatus === 'sent' || updatedStatus === 'confirmed')) {
      await query(
        `UPDATE interviews SET booking_status = $1, updated_at = NOW() WHERE id = $2`,
        [updatedStatus === 'confirmed' ? 'confirmed' : 'invitation_sent', current.interview_id]
      );
    }

    await logAudit({
      actor: sent_by,
      actorRole: 'committee',
      action: 'WA_MESSAGE_UPDATED',
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
// 10. محاكي الفحص الأعمى والإعدادات وسجل التدقيق (AIEngine & Settings)
// ---------------------------------------------------------------------------------

app.post('/api/ai/simulate', async (req, res) => {
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

    const evalPreview = await evaluateSubmission({
      job: { ...job, questions: (job.questions || []).slice(0, 3) },
      candidate: {
        full_name: candidate_name,
        years_experience: 4,
        qualification: 'بكالوريوس',
        cv_filename: 'simulated.pdf',
        cv_extracted_text: anonymized
      },
      answers: [
        { question_index: 1, answer_value: '1' },
        { question_index: 2, answer_value: '400' },
        { question_index: 3, answer_value: '1' }
      ],
      telemetry: { tab_switches: 0, paste_attempts: 0 }
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

app.get('/api/settings', async (_req, res) => {
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

app.put('/api/settings/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { setting_value, category = 'ai_provider', description = '', updated_by = 'مدير النظام' } = req.body;

    if (!setting_value || typeof setting_value !== 'object') {
      return res.status(400).json({ error: 'قيمة الإعداد يجب أن تكون كائن JSON صالحاً.' });
    }

    // ضمان عدم حفظ أي مفاتيح API سرية قادمة من المتصفح في قاعدة البيانات
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
      [key, JSON.stringify(sanitizedValue), category, description, updated_by]
    );

    if (key === 'ranking_weights') {
      await query('SELECT fn_sync_application_weighted_score(id) FROM applications');
    }

    await logAudit({
      actor: updated_by,
      actorRole: 'admin',
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

app.get('/api/audit-logs', async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit || '30', 10));
    const { rows } = await query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1', [limit]);
    res.json({ logs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// معالج أخطاء رفع الملفات والأخطاء العامة
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

// بدء تشغيل الخادم بعد التحقق من قاعدة البيانات
ensureDatabaseInitialized()
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`=============================================================`);
      console.log(`🚀 منصة التوظيف الذكية تعمل الآن على http://${HOST}:${PORT}`);
      console.log(`🗄️  قاعدة البيانات PostgreSQL متصلة وجاهزة (smart_hr_db)`);
      console.log(`=============================================================`);
    });
  })
  .catch((err) => {
    console.error('فشل الاتصال الأولي بقاعدة البيانات:', err.message);
    process.exit(1);
  });
