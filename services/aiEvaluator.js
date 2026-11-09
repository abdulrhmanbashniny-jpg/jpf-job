const crypto = require('crypto');

/**
 * تحويل الأرقام العربية المشرقية (٠-٩) والفواصل إلى أرقام قياسية قابلة للحساب
 */
function normalizeNumber(raw) {
  if (raw === null || raw === undefined) return NaN;
  const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
  const normalized = String(raw)
    .replace(/[٠-٩]/g, (d) => String(arabicDigits.indexOf(d)))
    .replace(/[,،%\s]/g, '')
    .replace(/[^\d.-]/g, '');
  return parseFloat(normalized);
}

/**
 * إخفاء الهوية الشخصية (Blind Screening) لمنع التحيز قبل التحليل
 */
function anonymizeText(text, candidate = {}) {
  if (!text) return '';
  let clean = String(text);
  clean = clean.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[بريد_محجوب]');
  clean = clean.replace(/(\+?966|05)\d{8,9}/g, '[جوال_محجوب]');
  if (candidate.full_name) {
    const parts = String(candidate.full_name).split(/\s+/).filter((w) => w.length > 2);
    for (const part of parts) {
      const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      clean = clean.replace(new RegExp(escaped, 'gi'), '[مرشح]');
    }
  }
  return clean;
}

/**
 * استخراج JSON بأمان حتى من نماذج التفكير مثل deepseek-r1 على Ollama
 */
function safeParseModelJson(rawText) {
  if (!rawText) return null;
  const cleaned = String(rawText)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (_e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_e2) {
        return null;
      }
    }
    return null;
  }
}

function resolveOllamaBaseUrl(customUrl) {
  const raw = customUrl || process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434';
  return String(raw).replace(/\/+$/, '');
}

/**
 * جلب قائمة الموديلات المثبتة فعلياً على خادم Ollama المحلي
 */
async function listOllamaModels(customBaseUrl) {
  const candidates = [
    resolveOllamaBaseUrl(customBaseUrl),
    'http://ollama-yk6j-ollama-1:11434',
    'http://ollama:11434',
    'http://host.docker.internal:11434',
    'http://127.0.0.1:11434',
    'http://172.17.0.1:11434'
  ];
  const uniqueUrls = [...new Set(candidates)];

  for (const baseUrl of uniqueUrls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        const models = (data.models || []).map((m) => ({
          name: m.name,
          size_gb: m.size ? Number((m.size / (1024 ** 3)).toFixed(2)) : null,
          family: m.details?.family || '',
          parameter_size: m.details?.parameter_size || ''
        }));
        return { reachable: true, base_url: baseUrl, models };
      }
    } catch (_err) {
      clearTimeout(timer);
    }
  }

  return {
    reachable: false,
    base_url: resolveOllamaBaseUrl(customBaseUrl),
    models: [],
    hint: 'تأكد من تشغيل خدمة Ollama والسماح لجسر Docker بالوصول إلى المنفذ 11434.'
  };
}

/**
 * فحص استجابة موديل Ollama فعلياً (مُحسّن لبيئات CPU و GPU معاً)
 */
async function testOllamaModel({ baseUrl, model }) {
  const url = resolveOllamaBaseUrl(baseUrl);
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: 'json',
        keep_alive: '30m',
        options: { temperature: 0.1, num_ctx: 2048, num_predict: 200 },
        messages: [
          {
            role: 'user',
            content: 'أجب بصيغة JSON فقط تحتوي على المفتاح status وقيمته "جاهز للعمل بالعربية" والمفتاح engine وقيمته اسم الموديل. /no_think'
          }
        ]
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Ollama HTTP ${res.status}: ${txt.slice(0, 180)}`);
    }
    const data = await res.json();
    return {
      ok: true,
      latency_ms: Date.now() - start,
      model: data.model || model,
      reply: safeParseModelJson(data.message?.content) || data.message?.content
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * حساب نسبة مطابقة السيرة الذاتية والخبرة لمتطلبات الوظيفة
 */
function computeCvMatchScore(job, candidate) {
  let score = 50;
  const exp = Number(candidate.years_experience || 0);
  if (exp >= 4) score += 22;
  else if (exp >= 2) score += 16;
  else if (exp >= 1) score += 8;

  const qual = String(candidate.qualification || '');
  if (/ماجستير|دكتوراه|مهندس|بكالوريوس/i.test(qual)) score += 12;
  else if (/دبلوم/i.test(qual)) score += 8;

  if (candidate.cv_filename || candidate.cv_stored_path) score += 8;
  if (candidate.portfolio_url) score += 4;

  const cvText = `${candidate.cv_extracted_text || ''} ${qual}`.toLowerCase();
  const jobContext = `${job.title} ${job.department} ${(job.requirements || []).join(' ')}`.toLowerCase();
  const domainTerms = [
    'دهان', 'طلاء', 'مبيعات', 'مشاريع', 'جودة', 'مختبر', 'إنتاج', 'مستودع',
    'كيميائ', 'تغطية', 'استشاري', 'مقاولات', 'saso', 'astm', 'iso', 'erp', 'wms', 'b2b'
  ];
  let matchedTerms = 0;
  for (const term of domainTerms) {
    if (cvText.includes(term) && jobContext.includes(term)) {
      matchedTerms += 1;
    } else if (cvText.includes(term)) {
      matchedTerms += 0.5;
    }
  }
  score += Math.min(12, Math.round(matchedTerms * 3));
  return Math.min(98, Math.max(35, Number(score.toFixed(2))));
}

/**
 * تصحيح الأسئلة الـ 10 بدقة وفق نوع كل سؤال ومعايير التصحيح
 */
function gradeQuestionsDeterministically(jobQuestions, submittedAnswers) {
  const answerMap = new Map();
  for (const item of submittedAnswers || []) {
    answerMap.set(Number(item.question_index), item);
  }

  let totalMax = 0;
  let totalAwarded = 0;
  const gradedItems = [];

  for (const q of jobQuestions || []) {
    const idx = Number(q.index);
    const maxPoints = Number(q.points || 10);
    totalMax += maxPoints;

    const sub = answerMap.get(idx) || {};
    const rawVal = sub.answer_value !== undefined && sub.answer_value !== null ? String(sub.answer_value).trim() : '';
    const attachmentPath = sub.attachment_path || null;
    const timeTaken = Math.max(0, parseInt(sub.time_taken_seconds || 0, 10) || 0);

    let awarded = 0;
    let feedback = '';

    if (q.type === 'mcq') {
      const chosen = parseInt(rawVal, 10);
      if (!Number.isNaN(chosen) && chosen === Number(q.correct_option)) {
        awarded = maxPoints;
        feedback = q.explanation
          ? `إجابة صحيحة ومطابقة للمعيار المهني. (${q.explanation})`
          : 'إجابة صحيحة ومطابقة للمعيار المهني المعتمد.';
      } else if (rawVal === '') {
        awarded = 0;
        feedback = 'لم تتم الإجابة على هذا السؤال.';
      } else {
        awarded = 0;
        const rightText = Array.isArray(q.options) ? q.options[Number(q.correct_option)] : '';
        feedback = `إجابة غير دقيقة. الخيار الأصح مهنياً: "${rightText}".`;
      }
    } else if (q.type === 'numeric') {
      const numericVal = normalizeNumber(rawVal);
      const expected = Number(q.correct_number);
      const tolerance = Number(q.tolerance ?? 1);
      if (!Number.isNaN(numericVal)) {
        const diff = Math.abs(numericVal - expected);
        if (diff <= tolerance) {
          awarded = maxPoints;
          feedback = `إجابة حسابية دقيقة (${numericVal} ${q.unit || ''}).`;
        } else if (diff <= Math.max(tolerance * 3, Math.abs(expected) * 0.1)) {
          awarded = Number((maxPoints * 0.5).toFixed(2));
          feedback = `قيمة قريبة من الناتج القياسي (${expected} ${q.unit || ''}) — تم منح نصف الدرجة.`;
        } else {
          awarded = 0;
          feedback = `الناتج المدخل (${numericVal}) يختلف عن الناتج الصحيح (${expected} ${q.unit || ''}).`;
        }
      } else {
        awarded = 0;
        feedback = 'لم يتم إدخال قيمة رقمية صالحة.';
      }
    } else if (q.type === 'text') {
      const words = rawVal.split(/\s+/).filter(Boolean);
      const minWords = Number(q.min_words || 15);
      const keywords = Array.isArray(q.keywords) ? q.keywords : [];

      if (words.length === 0) {
        awarded = 0;
        feedback = 'لم يتم تقديم إجابة نصية.';
      } else {
        let ratio = 0.25;
        if (words.length >= minWords) ratio += 0.35;
        else if (words.length >= Math.ceil(minWords * 0.5)) ratio += 0.2;

        let hitCount = 0;
        for (const kw of keywords) {
          if (rawVal.includes(kw)) hitCount += 1;
        }
        if (keywords.length > 0) {
          ratio += Math.min(0.4, (hitCount / Math.min(4, keywords.length)) * 0.4);
        } else if (words.length >= minWords) {
          ratio += 0.35;
        }

        awarded = Number(Math.min(maxPoints, maxPoints * ratio).toFixed(2));
        if (awarded >= maxPoints * 0.8) {
          feedback = `تحليل منهجي متميز شمل الجوانب العملية الرئيسية (${hitCount} محاور تخصصية).`;
        } else if (awarded >= maxPoints * 0.5) {
          feedback = 'إجابة مقبولة تغطي الأساسيات، وتحتاج لتفصيل أعمق في خطوات التنفيذ الميداني.';
        } else {
          feedback = 'إجابة مقتضبة جداً ولا تغطي المحاور الفنية المطلوبة للسؤال.';
        }
      }
    } else if (q.type === 'portfolio') {
      const words = rawVal.split(/\s+/).filter(Boolean);
      const keywords = Array.isArray(q.keywords) ? q.keywords : [];
      let hitCount = 0;
      for (const kw of keywords) {
        if (rawVal.includes(kw)) hitCount += 1;
      }

      if (attachmentPath && words.length >= 8) {
        awarded = maxPoints;
        feedback = 'تم إرفاق ملف عمل/شهادة موثقة مع شرح مهني وافٍ.';
      } else if (attachmentPath) {
        awarded = Number((maxPoints * 0.85).toFixed(2));
        feedback = 'تم إرفاق ملف داعم بنجاح.';
      } else if (words.length >= 15) {
        const bonus = Math.min(0.25, hitCount * 0.08);
        awarded = Number((maxPoints * (0.65 + bonus)).toFixed(2));
        feedback = 'تم تقديم ملخص تطبيقي مكتوب بدون ملف مرفق.';
      } else if (words.length > 0) {
        awarded = Number((maxPoints * 0.35).toFixed(2));
        feedback = 'ملخص قصير بدون إرفاق نموذج عمل داعم.';
      } else {
        awarded = 0;
        feedback = 'لم يتم إرفاق ملف أعمال أو كتابة نموذج مقترح.';
      }
    }

    totalAwarded += awarded;
    gradedItems.push({
      question_index: idx,
      question_type: q.type,
      question_text: q.question,
      answer_value: rawVal,
      attachment_path: attachmentPath,
      max_points: maxPoints,
      awarded_points: awarded,
      ai_feedback: feedback,
      time_taken_seconds: timeTaken
    });
  }

  const percentage = totalMax > 0 ? Number(((totalAwarded / totalMax) * 100).toFixed(2)) : 0;
  return { gradedItems, assessmentScore: percentage };
}

/**
 * استدعاء مزود ذكاء اصطناعي (يدعم Ollama المحلي + OpenAI + Gemini + Claude + DeepSeek)
 */
async function callExternalAIProvider(provider, config, systemPrompt, userPayload) {
  const timeoutMs = provider === 'ollama' ? 120000 : 12000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (provider === 'ollama') {
      const baseUrl = resolveOllamaBaseUrl(config.ollama_base_url);
      const model = config.model_name || process.env.OLLAMA_MODEL || 'qwen2.5:3b';
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          format: 'json',
          keep_alive: '30m',
          options: {
            temperature: Number(config.temperature ?? 0.2),
            num_ctx: 2048,
            num_predict: 500
          },
          messages: [
            { role: 'system', content: `${systemPrompt} /no_think` },
            { role: 'user', content: JSON.stringify(userPayload) }
          ]
        }),
        signal: controller.signal
      });
      if (res.ok) {
        const data = await res.json();
        return safeParseModelJson(data.message?.content);
      }
    } else if (provider === 'openai' && process.env.OPENAI_API_KEY) {
      const model = config.model_name || process.env.OPENAI_MODEL || 'gpt-4o-mini';
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model,
          temperature: Number(config.temperature ?? 0.2),
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(userPayload) }
          ]
        }),
        signal: controller.signal
      });
      if (res.ok) {
        const data = await res.json();
        return safeParseModelJson(data.choices?.[0]?.message?.content);
      }
    } else if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
      const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\n${JSON.stringify(userPayload)}` }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
        }),
        signal: controller.signal
      });
      if (res.ok) {
        const data = await res.json();
        return safeParseModelJson(data.candidates?.[0]?.content?.parts?.[0]?.text);
      }
    } else if (provider === 'deepseek' && process.env.DEEPSEEK_API_KEY) {
      const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(userPayload) }
          ]
        }),
        signal: controller.signal
      });
      if (res.ok) {
        const data = await res.json();
        return safeParseModelJson(data.choices?.[0]?.message?.content);
      }
    } else if (provider === 'claude' && process.env.ANTHROPIC_API_KEY) {
      const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model,
          max_tokens: 900,
          system: systemPrompt,
          messages: [{ role: 'user', content: JSON.stringify(userPayload) }]
        }),
        signal: controller.signal
      });
      if (res.ok) {
        const data = await res.json();
        return safeParseModelJson(data.content?.[0]?.text);
      }
    }
  } catch (err) {
    console.warn(`[AI Provider Fallback] تعذر الاتصال بالمزود (${provider})، تم التبديل لمحرك التقييم المدمج:`, err.message);
  } finally {
    clearTimeout(timer);
  }
  return null;
}

/**
 * التقييم الشامل للطلب (تقييم الأسئلة + مطابقة السيرة + النزاهة + التقرير الأعمى)
 */
async function evaluateSubmission({ job, candidate, answers, telemetry = {}, aiConfig = {} }) {
  const { gradedItems, assessmentScore } = gradeQuestionsDeterministically(job.questions || [], answers);
  const cvMatchScore = computeCvMatchScore(job, candidate);

  const cvWeight = Number(aiConfig.cv_weight_in_ai ?? 30) / 100;
  const assessWeight = Number(aiConfig.assessment_weight_in_ai ?? 70) / 100;
  const aiOverallScore = Number((cvMatchScore * cvWeight + assessmentScore * assessWeight).toFixed(2));

  const tabSwitches = Math.max(0, parseInt(telemetry.tab_switches || 0, 10) || 0);
  const pasteAttempts = Math.max(0, parseInt(telemetry.paste_attempts || 0, 10) || 0);
  const penaltySwitch = Number(aiConfig.integrity_penalty_per_switch ?? 4);
  const penaltyPaste = Number(aiConfig.integrity_penalty_per_paste ?? 5);
  const integrityScore = Math.max(0, Math.min(100, 100 - tabSwitches * penaltySwitch - pasteAttempts * penaltyPaste));

  const blindCode = `CAND-BLIND-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

  const mcqRight = gradedItems.filter((i) => i.question_type === 'mcq' && i.awarded_points >= i.max_points * 0.9).length;
  const numRight = gradedItems.filter((i) => i.question_type === 'numeric' && i.awarded_points >= i.max_points * 0.9).length;
  const textStrong = gradedItems.filter((i) => i.question_type === 'text' && i.awarded_points >= i.max_points * 0.7).length;
  const hasPortfolio = gradedItems.some((i) => i.question_type === 'portfolio' && i.awarded_points >= i.max_points * 0.7);

  const strengths = [];
  const gaps = [];

  if (mcqRight >= 3) strengths.push(`إلمام قوي بالمعايير الفنية والتشغيلية لوظيفة ${job.title} (${mcqRight} من 4 في الاختيار المتعدد)`);
  else gaps.push('يحتاج إلى تعزيز المعرفة بالمعايير الفنية واللوائح القياسية للقطاع');

  if (numRight >= 2) strengths.push('دقة ممتازة في العمليات الحسابية والهندسية ومؤشرات الأداء الرقمية');
  else if (numRight === 1) gaps.push('مراجعة الدقة في بعض الحسابات الكمية والمالية المرتبطة بالدور الوظيفي');
  else gaps.push('ضعف واضح في المسائل الحسابية والكمية المطلوبة للوظيفة');

  if (textStrong >= 2) strengths.push('قدرة تحليلية واضحة على صياغة خطط العمل الميدانية ومعالجة المواقف العملية');
  else gaps.push('الإجابات التحليلية تحتاج إلى خطوات إجرائية أكثر تفصيلاً وارتباطاً بالميدان');

  if (hasPortfolio) strengths.push('تقديم نماذج أعمال/مرفقات مهنية تدعم الخبرة التطبيقية');
  else gaps.push('يُنصح بطلب نماذج أعمال أو شهادات إضافية أثناء المقابلة الشخصية');

  if (integrityScore >= 92) strengths.push(`مؤشر نزاهة مرتفع جداً (${integrityScore}%) أثناء تأدية الاختبار`);
  else if (integrityScore < 80) gaps.push(`لوحظ مغادرة التبويب (${tabSwitches}) أو محاولات لصق (${pasteAttempts}) أثناء الاختبار`);

  const passingThreshold = Number(job.passing_score || 60);
  const passed = assessmentScore >= passingThreshold;

  let recommendation = passed
    ? (aiOverallScore >= 82 ? 'توصية قوية بالمقابلة (Strong Shortlist)' : 'مؤهل للمقابلة الشخصية ومراجعة اللجنة')
    : 'لم يجتز الحد الأدنى لاختبار الجدارة (60%)';

  let blindSummary = `تقييم مؤتمت بنظام الفحص الأعمى (${blindCode}) لوظيفة (${job.title} - ${job.code}): حقق المتقدم درجة ${assessmentScore}% في اختبار الجدارة و${cvMatchScore}% في مطابقة الخبرة، بمتوسط ذكاء اصطناعي مرجح قدره ${aiOverallScore}% ومؤشر نزاهة ${integrityScore}%.`;

  let providerUsed = 'smart-rubric';
  const requestedProvider = aiConfig.active_provider || process.env.AI_DEFAULT_PROVIDER || 'smart-rubric';

  if (requestedProvider !== 'smart-rubric') {
    const anonymizedPayload = {
      blind_code: blindCode,
      job_code: job.code,
      job_title: job.title,
      years_experience: candidate.years_experience,
      qualification: candidate.qualification,
      cv_excerpt: anonymizeText(candidate.cv_extracted_text, candidate),
      assessment_score: assessmentScore,
      integrity_score: integrityScore,
      answers: gradedItems.map((g) => ({
        q: g.question_text,
        a: anonymizeText(g.answer_value, candidate),
        score: `${g.awarded_points}/${g.max_points}`
      }))
    };

    const sysPrompt = `${job.ai_prompt}\nأعد النتيجة بصيغة JSON فقط تحتوي على المفاتيح: blind_summary (نص عربي موجز)، strengths (مصفوفة نصوص عربية)، gaps (مصفوفة نصوص عربية)، recommendation (نص عربي). لا تذكر أي أسماء شخصية.`;
    const extResult = await callExternalAIProvider(requestedProvider, aiConfig, sysPrompt, anonymizedPayload);
    if (extResult && extResult.blind_summary) {
      providerUsed = requestedProvider === 'ollama' ? `ollama:${aiConfig.model_name || process.env.OLLAMA_MODEL || 'local'}` : requestedProvider;
      blindSummary = extResult.blind_summary;
      if (Array.isArray(extResult.strengths) && extResult.strengths.length) {
        strengths.splice(0, strengths.length, ...extResult.strengths.slice(0, 4));
      }
      if (Array.isArray(extResult.gaps) && extResult.gaps.length) {
        gaps.splice(0, gaps.length, ...extResult.gaps.slice(0, 3));
      }
      if (extResult.recommendation) recommendation = extResult.recommendation;
    }
  }

  return {
    gradedItems,
    cvMatchScore,
    assessmentScore,
    aiOverallScore,
    integrityScore,
    passed,
    aiReport: {
      provider_used: providerUsed,
      blind_code: blindCode,
      blind_summary: blindSummary,
      strengths,
      gaps,
      recommendation
    }
  };
}

/**
 * فحص حالة مزودي الذكاء الاصطناعي بما فيها Ollama المحلي
 */
function getProvidersEnvStatus() {
  return {
    ollama: {
      configured: true,
      model: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
      base_url: resolveOllamaBaseUrl(),
      label: 'Ollama Local LLM (موديلات محلية على خادمك)'
    },
    'smart-rubric': {
      configured: true,
      mode: 'built-in',
      label: 'محرك التقييم الدلالي المدمج (Smart Rubric)'
    },
    openai: {
      configured: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      label: 'OpenAI GPT-4o'
    },
    gemini: {
      configured: Boolean(process.env.GEMINI_API_KEY),
      model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      label: 'Google Gemini'
    },
    claude: {
      configured: Boolean(process.env.ANTHROPIC_API_KEY),
      model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
      label: 'Anthropic Claude'
    },
    deepseek: {
      configured: Boolean(process.env.DEEPSEEK_API_KEY),
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      label: 'DeepSeek AI'
    }
  };
}

module.exports = {
  evaluateSubmission,
  anonymizeText,
  computeCvMatchScore,
  getProvidersEnvStatus,
  listOllamaModels,
  testOllamaModel
};
