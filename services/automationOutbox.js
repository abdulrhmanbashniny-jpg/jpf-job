/**
 * صندوق أحداث الأتمتة (automation_outbox) وتسليمها إلى n8n — v2.5
 * ---------------------------------------------------------------------------------
 * المبدأ الحاكم: **n8n ليس حاجة حرجة**. أي تعطّل في n8n لا يجوز أن يُفشل:
 *   - إصدار عرض وظيفي،
 *   - توقيع المرشح أو اعتذاره،
 *   - أي عملية توظيف أخرى.
 *
 * لذلك:
 *   - الحدث يُكتب في القاعدة أولاً داخل نفس معاملة العملية (transactional outbox).
 *   - التسليم يحدث بعدياً (best-effort) ولا يعيد رمي أخطاء أبداً.
 *   - كل حدث موقّع بـ HMAC-SHA256 على النص الخام، مع طابع زمني يمنع إعادة التشغيل.
 *   - إعادة المحاولة أسّية مع سقف محاولات، ثم تُعلَّم 'abandoned' بلا أثر على التوظيف.
 *   - التسليم معطّل افتراضياً: N8N_WEBHOOK_ENABLED يجب أن يكون 'true' صراحةً.
 */
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const DEFAULTS = Object.freeze({
  enabledWhenEnv: 'true',
  maxAttempts: 8,
  baseDelayMs: 2000,
  maxDelayMs: 5 * 60 * 1000,
  timeoutMs: 5000
});

/** هل التسليم مفعّل؟ لا بلا تصريح صريح */
function isDeliveryEnabled(env = process.env) {
  return String(env.N8N_WEBHOOK_ENABLED || '').toLowerCase() === DEFAULTS.enabledWhenEnv;
}

/**
 * هل الاسم يشير إلى الجهاز نفسه أو شبكة داخلية؟
 * القاعدة: n8n خدمة خارجية يجب أن تكون على شبكة حقيقية. أي عنوان يُوجَّه
 * إلى الجهاز المحلي أو إلى نطاق خاص/رابط محلي يُرفض.
 */
function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  // أسماء محلية صريحة
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  // IPv6: ::1 وأي عنوان loopback آخر (::، 0:0:0:0:0:0:0:1 …)
  if (h === '::' || h === '::1' || /^0*(:0*)*:0*1$/.test(h)) return true;
  // IPv4 mapped في IPv6  (::ffff:127.0.0.1 أو ::ffff:7f00:1)
  const mapped = /^::ffff:(.+)$/.exec(h);
  if (mapped) {
    const inner = mapped[1];
    if (inner.includes('.')) return isLoopbackHostname(inner);
    // صيغة سداسية عشرية: aabb:ccdd
    const hexPair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner);
    if (hexPair) {
      const hi = parseInt(hexPair[1], 16);
      const lo = parseInt(hexPair[2], 16);
      const ip = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
      return isLoopbackHostname(ip);
    }
    return true; // صيغة غير مفهومة ⇒ نرفضها احتياطاً
  }
  // IPv4: كامل نطاق 127.0.0.0/8 لا 127.0.0.1 فقط
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return true;              // loopback كامل
    if (a === 0) return true;                // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local
    if (a === 10) return true;               // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;               // multicast / reserved
    return false;
  }
  // نطاقات محلية/رابط محلي بأسماء
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  return false;
}

/**
 * يتحقق من عنوان الـ webhook: يجب أن يكون http(s) صالحاً.
 * في الاختبارات المعزولة يُسمح بالـ loopback عبر N8N_ALLOW_LOOPBACK_FOR_TESTS=1 فقط.
 */
function validateWebhookUrl(rawUrl, env = process.env) {
  let u;
  try {
    u = new URL(String(rawUrl || ''));
  } catch (_e) {
    return { ok: false, reason: 'INVALID_URL' };
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    return { ok: false, reason: 'UNSUPPORTED_PROTOCOL' };
  }
  if (isLoopbackHostname(u.hostname) && String(env.N8N_ALLOW_LOOPBACK_FOR_TESTS || '') !== '1') {
    return { ok: false, reason: 'LOOPBACK_BLOCKED' };
  }
  return { ok: true, url: u.toString() };
}

/** توقيع HMAC على النص الخام + الطابع الزمني (يمنع إعادة التشغيل) */
function signPayload(rawBody, secret, timestampSeconds) {
  const ts = Number.isFinite(timestampSeconds) ? timestampSeconds : Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac('sha256', String(secret || ''))
    .update(`${ts}.${rawBody}`)
    .digest('hex');
  return { timestamp: ts, signature, header: `t=${ts},v1=${signature}` };
}

/** يتحقق من توقيع وارد (للاختبار ولمستقبل الاختبار المحلي) */
function verifySignature(rawBody, secret, header, { toleranceSeconds = 300, nowSeconds } = {}) {
  const m = String(header || '').match(/^t=(\d+),v1=([a-f0-9]{64})$/);
  if (!m) return { ok: false, reason: 'MALFORMED_HEADER' };
  const ts = Number(m[1]);
  const provided = m[2];
  const now = Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) return { ok: false, reason: 'STALE_TIMESTAMP' };
  const expected = crypto.createHmac('sha256', String(secret || '')).update(`${ts}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }
  return { ok: true, timestamp: ts };
}

function backoffMs(attempt, { baseDelayMs = DEFAULTS.baseDelayMs, maxDelayMs = DEFAULTS.maxDelayMs } = {}) {
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)));
  // ارتجاج عشوائي بسيط لتجنّب تزامن المحاولات
  return Math.round(exp * (0.75 + Math.random() * 0.5));
}

/** POST بسيط بلا أي اعتمادية خارجية، مع مهلة صارمة */
function postJson(urlString, rawBody, headers = {}, timeoutMs = DEFAULTS.timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let u;
    try {
      u = new URL(urlString);
    } catch (_e) {
      return done({ ok: false, statusCode: 0, error: 'INVALID_URL' });
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(rawBody),
          'User-Agent': 'JPF-SmartHR/2.5 (outbox)',
          ...headers
        },
        timeout: timeoutMs
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          if (body.length < 4096) body += String(c);
        });
        res.on('end', () =>
          done({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            statusCode: res.statusCode || 0,
            responseSnippet: body.slice(0, 500)
          })
        );
      }
    );
    req.on('timeout', () => {
      req.destroy();
      done({ ok: false, statusCode: 0, error: 'TIMEOUT' });
    });
    req.on('error', (err) => done({ ok: false, statusCode: 0, error: err.code || err.message }));
    req.write(rawBody);
    req.end();
  });
}

/**
 * يكتب حدثاً في الصندوق. يجب استدعاؤه بمُهيّئ الاستعلام (client) داخل معاملة العملية
 * كي يكون الحدث ذرّياً مع العملية نفسها.
 * لا يرمي أخطاء: إن فشل الكتابة تُرجع { enqueued:false } فقط، ولا تتأثر العملية.
 */
async function enqueueEvent(dbQuery, {
  eventType, aggregateType, aggregateId, payload, idempotencyKey
}) {
  try {
    const body = JSON.stringify(payload || {});
    const payloadSha = crypto.createHash('sha256').update(body).digest('hex');
    const key = String(idempotencyKey || `${eventType}:${aggregateType}:${aggregateId}`);
    const { rows } = await dbQuery(
      `INSERT INTO automation_outbox
         (event_type, aggregate_type, aggregate_id, payload, payload_sha256, idempotency_key)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [eventType, aggregateType, String(aggregateId), body, payloadSha, key]
    );
    return { enqueued: rows.length > 0, id: rows[0] ? rows[0].id : null, idempotent: rows.length === 0 };
  } catch (_err) {
    // الصندوق لا يجوز أن يُفشل عملية توظيف
    return { enqueued: false, error: 'ENQUEUE_FAILED' };
  }
}

/**
 * يحاول تسليم دفعة من الأحداث المستحقة.
 * - يعيد إحصائية فقط، ولا يرمي أخطاء.
 * - إن كان التسليم معطّلاً، يعيد { skipped:true } بدون لمس الصفوف.
 */
async function deliverBatch(query, {
  limit = 20,
  env = process.env,
  now = () => new Date(),
  post = postJson
} = {}) {
  const stats = { attempted: 0, delivered: 0, failed: 0, abandoned: 0, skipped: false, reason: null, results: [] };

  if (!isDeliveryEnabled(env)) {
    stats.skipped = true;
    stats.reason = 'N8N_WEBHOOK_ENABLED_NOT_TRUE';
    return stats;
  }

  const target = validateWebhookUrl(env.N8N_OFFER_WEBHOOK_URL, env);
  if (!target.ok) {
    stats.skipped = true;
    stats.reason = target.reason;
    return stats;
  }

  const secret = String(env.N8N_WEBHOOK_SECRET || '');
  if (!secret) {
    stats.skipped = true;
    stats.reason = 'N8N_WEBHOOK_SECRET_MISSING';
    return stats;
  }

  let rows = [];
  try {
    const res = await query(
      `SELECT id, event_type, aggregate_type, aggregate_id, payload, attempt_count, idempotency_key
       FROM automation_outbox
       WHERE delivery_status IN ('pending','failed')
         AND next_attempt_at <= $1
       ORDER BY id
       LIMIT $2`,
      [now(), limit]
    );
    rows = res.rows;
  } catch (_e) {
    stats.skipped = true;
    stats.reason = 'OUTBOX_QUERY_FAILED';
    return stats;
  }

  for (const row of rows) {
    stats.attempted += 1;
    const rawBody = JSON.stringify({
      event: row.event_type,
      aggregate: { type: row.aggregate_type, id: row.aggregate_id },
      idempotency_key: row.idempotency_key,
      payload: row.payload,
      sent_at: now().toISOString()
    });
    const { header } = signPayload(rawBody, secret);

    let result;
    try {
      result = await post(target.url, rawBody, {
        'X-JPF-Signature': header,
        'X-JPF-Event': String(row.event_type),
        'X-JPF-Delivery': String(row.idempotency_key)
      });
    } catch (err) {
      result = { ok: false, statusCode: 0, error: err && err.message };
    }

    const attempts = Number(row.attempt_count || 0) + 1;
    if (result.ok) {
      stats.delivered += 1;
      stats.results.push({ id: row.id, ok: true, statusCode: result.statusCode });
      await query(
        `UPDATE automation_outbox
         SET delivery_status='delivered', attempt_count=$2, last_attempt_at=NOW(),
             delivered_at=NOW(), last_error=NULL
         WHERE id=$1`,
        [row.id, attempts]
      ).catch(() => {});
    } else {
      const abandon = attempts >= DEFAULTS.maxAttempts;
      const delay = backoffMs(attempts);
      stats.failed += 1;
      if (abandon) stats.abandoned += 1;
      stats.results.push({ id: row.id, ok: false, statusCode: result.statusCode, error: result.error || null });
      await query(
        `UPDATE automation_outbox
         SET delivery_status=$2, attempt_count=$3, last_attempt_at=NOW(),
             last_error=$4, next_attempt_at=NOW() + ($5 || ' milliseconds')::interval
         WHERE id=$1`,
        [row.id, abandon ? 'abandoned' : 'failed', attempts,
         String(result.error || (result.statusCode ? `HTTP_${result.statusCode}` : 'UNKNOWN')).slice(0, 500),
         String(delay)]
      ).catch(() => {});
    }
  }

  return stats;
}

/** إحصائية الصندوق لعرضها للمشرف */
async function outboxStats(query) {
  try {
    const { rows } = await query(
      `SELECT delivery_status, COUNT(*)::int AS n,
              COALESCE(MAX(attempt_count), 0)::int AS max_attempts
       FROM automation_outbox GROUP BY delivery_status`
    );
    const out = { pending: 0, delivered: 0, failed: 0, abandoned: 0, total: 0, max_attempts: 0 };
    for (const r of rows) {
      if (out[r.delivery_status] !== undefined) out[r.delivery_status] = r.n;
      out.total += r.n;
      out.max_attempts = Math.max(out.max_attempts, r.max_attempts);
    }
    return out;
  } catch (_e) {
    return { pending: 0, delivered: 0, failed: 0, abandoned: 0, total: 0, max_attempts: 0, unavailable: true };
  }
}

module.exports = {
  DEFAULTS,
  isDeliveryEnabled,
  validateWebhookUrl,
  signPayload,
  verifySignature,
  backoffMs,
  postJson,
  enqueueEvent,
  deliverBatch,
  outboxStats
};
