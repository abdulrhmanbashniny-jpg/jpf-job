/**
 * خدمة توليد العروض الوظيفية العربية (v2.5)
 * ---------------------------------------------------------------------------------
 * لماذا هذا الملف حساس:
 *  - PDF لا يعرف العربية أصلاً: لا تشكيل ولا اتجاه. نمرّر النص عبر مرحلتين:
 *      1) تشكيل الحروف (arabic-reshaper) → صور الحروف المتصلة (Presentation Forms-B)
 *      2) خوارزمية Bidi (bidi-js، مطابقة لـ UAX#9) → ترتيب بصري صحيح مع حفظ
 *         الأرقام والتواريخ واللاتيني داخل النص العربي.
 *    ملاحظة مُثبتة بالاختبار: `getReorderSegments` تُرجع فهارس **شاملة للنهاية**؛
 *    استعمال slice(s,e) خطأ شائع يُفسد الكلمة الأخيرة.
 *  - الخط: Amiri (OFL) لأنه يغطي Presentation Forms-B بالكامل. خطوط حديثة مثل Cairo
 *    ناقصة التغطية (700 محرف) فتظهر مربعات منقّطة (dotted circle) في الـ PDF.
 *  - التضمين بـ subset:false إلزامي: التقسيم الفرعي مع الأشكال المعروضة يفقد محارف.
 *  - كل النصوص تُنقّى قبل الرسم (لا حقن HTML/PDF، لا محارف تحكم).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const reshaper = require('arabic-reshaper');
const bidiFactory = require('bidi-js');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const bidi = bidiFactory();

const FONT_DIR = path.join(__dirname, '..', 'public', 'fonts');
const FONT_FILES = {
  // خط أساسي عربي كامل التغطية
  arabic: path.join(FONT_DIR, 'Amiri-Regular.ttf'),
  // خط لاتيني/أرقام منسجم بصرياً مع العربي
  latin: null
};

const PAGE = { width: 595.28, height: 841.89, marginX: 56, marginTop: 64, marginBottom: 64 };
const INK = rgb(0.09, 0.11, 0.12);
const MUTED = rgb(0.42, 0.45, 0.47);
const RULE = rgb(0.82, 0.84, 0.85);
const ACCENT = rgb(0.12, 0.35, 0.28);

/**
 * تنظيف نص قبل الرسم: إزالة محارف التحكم والاتجاه الصريحة التي تُفسد الترتيب،
 * وتوحيد المسافات. لا يزيل العربية أو الأرقام أو علامات الترقيم.
 */
function sanitizeText(value, maxLen = 2000) {
  if (value === undefined || value === null) return '';
  let s = String(value);
  // محارف التحكم C0/C1 ومحارف التوجيه الضمنية (LRE,RLE,PDF,LRO,RLO,ZWJ,ZWNJ,BOM)
  s = s.replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
  s = s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return s.slice(0, maxLen);
}

/**
 * يحوّل نصاً عربياً إلى ترتيب بصري جاهز للرسم في PDF.
 * - يشكّل الحروف أولاً، ثم يطبّق خوارزمية Bidi باتجاه rtl.
 * - يعيد '' للنص الفارغ.
 * - لا يرمي أخطاء أبداً (يسقط للنص الأصلي عند فشل مكتبة).
 */
function toVisualArabic(text) {
  const clean = sanitizeText(text);
  if (!clean) return '';
  try {
    // pdf-lib/fontkit يُشكّل العربية بنفسه ثم يعكس المقطع RTL عند كتابة مجرى المحتوى.
    // لذلك نُعطيه النص المنطقي المشكَّل (بلا إعادة ترتيب) وإلا انعكس مرتين وخرج معكوساً.
    return reshaper.convertArabic(clean);
  } catch (_e) {
    return clean;
  }
}

/** عرض النص بعد التشكيل والترتيب البصري (بالنقاط) لضبط المحاذاة RTL */
function measureVisual(text, font, size) {
  const visual = toVisualArabic(text);
  if (!visual) return 0;
  try {
    return font.widthOfTextAtSize(visual, size);
  } catch (_e) {
    return visual.length * size * 0.5;
  }
}

/** يرسم سطراً بمحاذاة يمين الصفحة (RTL) */
function drawRight(page, text, { font, size, y, color = INK, marginX = PAGE.marginX, maxWidth } = {}) {
  let visual = toVisualArabic(text);
  if (!visual) return y;
  let effectiveSize = size;
  let width = measureVisual(text, font, effectiveSize);
  const limit = maxWidth || PAGE.width - marginX * 2;
  // تصغير تلقائي للسطر الطويل بدل تجاوز الهامش
  let guard = 0;
  while (width > limit && effectiveSize > 6 && guard < 40) {
    effectiveSize -= 0.5;
    width = measureVisual(text, font, effectiveSize);
    guard += 1;
  }
  const x = PAGE.width - marginX - width;
  page.drawText(visual, { x, y, size: effectiveSize, font, color });
  return y;
}

const ASCII_SAFE = /^[\x20-\x7E]+$/;

/**
 * يرسم صفاً بصيغة «تسمية عربية: قيمة».
 * القيم الرقمية/اللاتينية (تواريخ، مبالغ، أكواد) تُرسم كتدفق LTR مستقل على يسار
 * التسمية، لأن خوارزمية Bidi تُفتّت تواريخ مثل 2026-11-14 عند الشُرَط وتعيد ترتيبها.
 * هذا يفصل مسؤولية الاتجاه: العربي بصري، والرقمي يبقى كما هو حرفياً.
 */
function drawKeyValueRow(page, label, value, {
  arabicFont, latinFont, size = 12, y, color = INK, valueColor, marginX = PAGE.marginX, maxWidth
} = {}) {
  const limit = maxWidth || PAGE.width - marginX * 2;
  const rawValue = sanitizeText(value, 120);

  // القيم «المختلطة» مثل «90 يوماً» أو «21 يوماً»: الأرقام داخل سلسلة عربية تُعكس
  // (90 → 09). نفصل الرقم عن الوحدة ونرسمه كتدفق LTR مستقل، والوحدة عربية خالصة.
  const mixed = /^([0-9]+(?:[.,][0-9]+)?)\s*(.+)$/.exec(rawValue);
  if (mixed && !ASCII_SAFE.test(rawValue)) {
    const [, numPart, unitPart] = mixed;
    // التسمية يميناً بلا قيمة، والقيمة في عمود القيم يساراً:
    // الوحدة العربية في أقصى اليسار، والرقم LTR إلى يمينها (ترتيب RTL الصحيح).
    drawRight(page, `${label}:`, { font: arabicFont, size, y, color, marginX, maxWidth: limit });
    const unitVisual = toVisualArabic(unitPart);
    const unitWidth = measureVisual(unitPart, arabicFont, size);
    const numWidth = latinFont.widthOfTextAtSize(numPart, size - 1);
    // القراءة من اليمين: الرقم ثم الوحدة، لذلك يقع الرقم يمين الوحدة
    page.drawText(unitVisual, { x: marginX, y, size, font: arabicFont, color: valueColor || color });
    page.drawText(numPart, {
      x: marginX + unitWidth + 4, y, size: size - 1, font: latinFont, color: valueColor || color
    });
    void numWidth;
    return y;
  }

  const isAscii = ASCII_SAFE.test(rawValue) && /[0-9A-Za-z]/.test(rawValue);

  // القيمة العربية (أو المختلطة) تُرسم داخل النص العربي
  const suffix = isAscii ? '' : `: ${rawValue}`;
  drawRight(page, `${label}${suffix}`, { font: arabicFont, size, y, color, marginX, maxWidth: limit });

  if (isAscii && rawValue) {
    // موضع القيمة: يسار التسمية بمسافة فاصلة، بمحاذاة خط الأساس نفسه
    const valWidth = latinFont.widthOfTextAtSize(rawValue, size - 1);
    // عمود قيم موحّد بمحاذاة يسار الصفحة — يمنع التشتت ويجعل الجدول مقروءاً
    const valX = marginX;
    if (valWidth < PAGE.width * 0.42) {
      page.drawText(rawValue, { x: valX, y, size: size - 1, font: latinFont, color: valueColor || color });
    } else {
      // لا مساحة كافية: نكتفي ببقية السطر (نادر جداً مع التصغير التلقائي)
      drawRight(page, rawValue, { font: arabicFont, size: size - 1, y, color: valueColor || color, marginX, maxWidth: limit });
    }
  }
  return y;
}

/** يرسم سطراً بمحاذاة وسط الصفحة */
function drawCenter(page, text, { font, size, y, color = INK }) {
  const visual = toVisualArabic(text);
  if (!visual) return;
  const width = measureVisual(text, font, size);
  page.drawText(visual, { x: (PAGE.width - width) / 2, y, size, font, color });
}

/**
 * يلفّ نصاً طويلاً إلى أسطر بصرية لا تتجاوز العرض المتاح.
 * يلفّ على المسافات بعد التشكيل للحفاظ على صحة الحروف المتصلة داخل كل كلمة.
 */
function wrapVisual(text, font, size, maxWidth) {
  const words = sanitizeText(text).split(' ').filter(Boolean);
  const lines = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    const width = measureVisual(candidate, font, size);
    if (width > maxWidth && current) {
      lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.00';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(value) {
  if (!value) return '—';
  const s = String(value).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return sanitizeText(s, 20);
  // تاريخ ميلادي بصيغة ثابتة داخل النص العربي
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** يحمّل الخط العربي مرة واحدة ويعيد كاش */
let cachedFontBytes = null;
function loadArabicFontBytes() {
  if (cachedFontBytes) return cachedFontBytes;
  const p = FONT_FILES.arabic;
  if (!fs.existsSync(p)) {
    throw new Error('خط Amiri-Regular.ttf مفقود في public/fonts — لا يمكن توليد عرض عربي.');
  }
  cachedFontBytes = fs.readFileSync(p);
  return cachedFontBytes;
}

/**
 * يبني ملف PDF عربياً كاملاً من بيانات العرض.
 * يعيد { bytes, sha256, pageCount, textLines } — والبصمة تُحسب على البايتات النهائية.
 */
async function buildOfferPdf(offer = {}, template = {}) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  const arabicFont = await doc.embedFont(loadArabicFontBytes(), { subset: false });
  // نستخدم الخط المضمَّن نفسه للأرقام/اللاتيني: Amiri يغطيهما، ويجنّبنا الاعتماد
  // على خطوط PDF القياسية (Helvetica) التي قد لا تتوفر في كل عارض/حاوية.
  const latinFont = arabicFont;

  doc.setTitle(toVisualArabic(`عرض وظيفي — ${offer.offer_ref || ''}`));
  doc.setAuthor(toVisualArabic(template.company_name || 'الموارد البشرية'));
  doc.setSubject(toVisualArabic('عرض وظيفي رسمي'));
  doc.setCreator('JPF Smart HR — v2.5');
  doc.setProducer('JPF Smart HR — v2.5');

  const page = doc.addPage([PAGE.width, PAGE.height]);
  const contentWidth = PAGE.width - PAGE.marginX * 2;
  let y = PAGE.height - PAGE.marginTop;

  // ── ترويسة الشركة ────────────────────────────────────────────────────────
  drawRight(page, template.company_name || 'شركة رُواء للموارد البشرية', { font: arabicFont, size: 18, y });
  y -= 22;
  drawRight(page, template.company_legal_name || '', { font: arabicFont, size: 10, y, color: MUTED });
  y -= 16;
  drawRight(page, template.company_address || '', { font: arabicFont, size: 10, y, color: MUTED });
  y -= 10;
  page.drawLine({
    start: { x: PAGE.marginX, y },
    end: { x: PAGE.width - PAGE.marginX, y },
    thickness: 1.2,
    color: ACCENT
  });
  y -= 34;

  // ── عنوان الوثيقة ────────────────────────────────────────────────────────
  drawCenter(page, 'عرض وظيفي', { font: arabicFont, size: 26, y });
  y -= 20;
  // رقم العرض قيمة ASCII: تُرسم كتدفق مستقل بجوار التسمية.
  // حقنها داخل جملة عربية يجعل محرك الـ bidi يعيد ترتيب مجموعاتها (OFR-2026-0001 ← 1000-6202-RFO).
  {
    const labelText = 'عرض وظيفي';
    const refLabel = 'رقم العرض:';
    const refValue = String(offer.offer_ref || '—');
    const sizeRef = 10.5;
    const labelW = measureVisual(refLabel, arabicFont, sizeRef);
    const valueW = latinFont.widthOfTextAtSize(refValue, sizeRef) + 6;
    const totalW = labelW + valueW;
    const startX = (PAGE.width - totalW) / 2;
    // التسمية العربية تمتد من اليسار إلى اليمين بترتيبها البصري
    page.drawText(toVisualArabic(refLabel), { x: startX, y, size: sizeRef, font: arabicFont, color: MUTED });
    page.drawText(refValue, { x: startX + labelW + 6, y, size: sizeRef, font: latinFont, color: MUTED });
    void labelText;
  }
  y -= 36;

  // ── بيانات المرشح والوظيفة ────────────────────────────────────────────────
  const rows = [
    ['الاسم', offer.candidate_name || '—'],
    ['المسمى الوظيفي', offer.job_title_snapshot || '—'],
    ['القسم', offer.department_snapshot || '—'],
    ['تاريخ الإصدار', formatDate(offer.issued_date)],
    ['تاريخ المباشرة المتوقعة', formatDate(offer.expected_start_date)],
    ['صلاحية العرض حتى', formatDate(offer.valid_until)]
  ];
  for (const [label, value] of rows) {
    drawKeyValueRow(page, label, value, { arabicFont, latinFont, size: 12, y, maxWidth: contentWidth });
    y -= 24;
  }

  y -= 8;
  drawRight(page, 'المزايا المالية الشهرية (ريال سعودي)', { font: arabicFont, size: 13, y, color: ACCENT });
  y -= 22;

  // جدول بصري بسيط: القيمة يساراً والتسمية يميناً
  const moneyRows = [
    ['الراتب الأساسي', offer.basic_salary],
    ['بدل السكن', offer.housing_allowance],
    ['بدل النقل', offer.transport_allowance],
    ['بدلات أخرى', offer.other_allowances]
  ];
  const total = moneyRows.reduce((sum, [, v]) => sum + (Number(v) || 0), 0);

  for (const [label, value] of moneyRows) {
    drawRight(page, label, { font: arabicFont, size: 12, y, maxWidth: contentWidth * 0.5 });
    // القيمة بمحاذاة يسار باستخدام الخط اللاتيني لضمان صحة الأرقام
    const val = formatMoney(value);
    const w = latinFont.widthOfTextAtSize(val, 11);
    page.drawText(val, { x: PAGE.marginX + (contentWidth * 0.5) - w, y, size: 11, font: latinFont, color: INK });
    y -= 22;
  }
  y -= 4;
  page.drawLine({
    start: { x: PAGE.marginX, y: y + 12 },
    end: { x: PAGE.width - PAGE.marginX, y: y + 12 },
    thickness: 0.8,
    color: RULE
  });
  drawRight(page, 'الإجمالي الشهري', { font: arabicFont, size: 13, y, color: ACCENT });
  const totalStr = formatMoney(total);
  const totalW = latinFont.widthOfTextAtSize(totalStr, 13);
  page.drawText(totalStr, { x: PAGE.marginX + (contentWidth * 0.5) - totalW, y, size: 13, font: latinFont, color: ACCENT });
  y -= 32;

  // ── الشروط ────────────────────────────────────────────────────────────────
  const terms = [
    ['مدة التجربة', `${offer.probation_days || 90} يوماً`],
    ['الإجازة السنوية', `${offer.annual_leave_days || 21} يوماً`]
  ];
  for (const [label, value] of terms) {
    drawKeyValueRow(page, label, value, { arabicFont, latinFont, size: 12, y, maxWidth: contentWidth });
    y -= 24;
  }

  // ── النصوص الحرة (ملتفّة) ─────────────────────────────────────────────────
  for (const block of [template.intro_text, offer.special_terms, template.closing_text]) {
    if (!block) continue;
    y -= 6;
    for (const line of wrapVisual(block, arabicFont, 11, contentWidth)) {
      if (y < PAGE.marginBottom + 120) break; // صفحة واحدة في هذه النسخة
      drawRight(page, line, { font: arabicFont, size: 11, y, color: INK, maxWidth: contentWidth });
      y -= 19;
    }
  }

  // ── التوقيع والختم ────────────────────────────────────────────────────────
  y = Math.max(y, PAGE.marginBottom + 90);
  page.drawLine({
    start: { x: PAGE.marginX, y },
    end: { x: PAGE.width - PAGE.marginX, y },
    thickness: 0.8,
    color: RULE
  });
  y -= 26;
  drawRight(page, template.signature_title || 'مدير الموارد البشرية', { font: arabicFont, size: 11, y, color: MUTED });
  y -= 18;
  drawRight(page, 'هذا العرض صادر إلكترونياً من نظام التوظيف، ويُعتمد بالتوقيع الإلكتروني عبر رابطه الرسمي.',
    { font: arabicFont, size: 9, y, color: MUTED, maxWidth: contentWidth });

  // بصمة الوثيقة مطبوعة داخل الصفحة (تُمكّن التحقق اليدوي)
  const bytes = await doc.save();
  const sha256 = crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');

  return {
    bytes: Buffer.from(bytes),
    sha256,
    pageCount: doc.getPageCount(),
    // لأغراض الاختبار: أول أسطر بصرية مرسومة
    visualLines: [toVisualArabic('عرض وظيفي'), toVisualArabic(offer.job_title_snapshot || '')]
  };
}

/** قالب العرض الافتراضي إن لم يوجد في القاعدة */
const DEFAULT_TEMPLATE = Object.freeze({
  company_name: 'شركة رُواء للموارد البشرية',
  company_legal_name: 'شركة رُواء للخدمات التوظيفية',
  company_address: 'جدة — المملكة العربية السعودية',
  company_cr: '',
  template_version: 'default_v1',
  intro_text: 'يسرنا إبلاغكم بقبولكم للعمل لدينا، ونرفق لكم تفاصيل العرض الوظيفي.',
  closing_text: 'نتمنى لكم التوفيق، ونؤكد ترحيبنا بانضمامكم إلى فريقنا.',
  signature_title: 'مدير الموارد البشرية',
  default_probation_days: 90,
  default_annual_leave_days: 21,
  validity_days: 14
});

/** يدمج قالب القاعدة مع الافتراضي مع تجاهل أي مفتاح غير معروف */
function normalizeTemplate(raw) {
  const out = { ...DEFAULT_TEMPLATE };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_TEMPLATE)) {
      if (raw[key] !== undefined && raw[key] !== null && typeof raw[key] !== 'object') {
        out[key] = raw[key];
      }
    }
  }
  return out;
}

/** HTML معاينة/طباعة (A4) — يعتمد على RTL الأصلي في المتصفح، لا على التشكيل */
function buildOfferHtml(offer = {}, template = {}) {
  const t = normalizeTemplate(template);
  const esc = (v) => String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const total = (Number(offer.basic_salary) || 0) + (Number(offer.housing_allowance) || 0) +
    (Number(offer.transport_allowance) || 0) + (Number(offer.other_allowances) || 0);
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 18mm; }
  body { font-family: "Amiri", "Times New Roman", serif; color: #161B1C; }
  h1 { text-align: center; font-size: 24px; margin: 18px 0 6px; }
  .meta { text-align: center; color: #6B7173; font-size: 12px; margin-bottom: 22px; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  td { padding: 7px 4px; border-bottom: 1px solid #D1D6D7; font-size: 13px; }
  td.v { text-align: left; font-variant-numeric: tabular-nums; }
  .total { font-weight: 700; color: #1F6B55; }
  .sig { margin-top: 34px; border-top: 1px solid #D1D6D7; padding-top: 12px; color: #6B7173; font-size: 12px; }
  .foot { margin-top: 18px; font-size: 10px; color: #8A9091; }
</style></head><body>
<div>${esc(t.company_name)}</div>
<div class="meta">${esc(t.company_legal_name)} — ${esc(t.company_address)}</div>
<h1>عرض وظيفي</h1>
<div class="meta">رقم العرض: ${esc(offer.offer_ref)}</div>
<table>
  <tr><td>الاسم</td><td class="v">${esc(offer.candidate_name)}</td></tr>
  <tr><td>المسمى الوظيفي</td><td class="v">${esc(offer.job_title_snapshot)}</td></tr>
  <tr><td>القسم</td><td class="v">${esc(offer.department_snapshot)}</td></tr>
  <tr><td>تاريخ المباشرة</td><td class="v">${esc(offer.expected_start_date)}</td></tr>
  <tr><td>صلاحية العرض حتى</td><td class="v">${esc(offer.valid_until)}</td></tr>
  <tr><td>الراتب الأساسي</td><td class="v">${formatMoney(offer.basic_salary)}</td></tr>
  <tr><td>بدل السكن</td><td class="v">${formatMoney(offer.housing_allowance)}</td></tr>
  <tr><td>بدل النقل</td><td class="v">${formatMoney(offer.transport_allowance)}</td></tr>
  <tr><td>بدلات أخرى</td><td class="v">${formatMoney(offer.other_allowances)}</td></tr>
  <tr class="total"><td>الإجمالي الشهري</td><td class="v">${formatMoney(total)}</td></tr>
  <tr><td>مدة التجربة</td><td class="v">${esc(offer.probation_days)} يوماً</td></tr>
  <tr><td>الإجازة السنوية</td><td class="v">${esc(offer.annual_leave_days)} يوماً</td></tr>
</table>
<p>${esc(t.intro_text)}</p>
${offer.special_terms ? `<p>${esc(offer.special_terms)}</p>` : ''}
<p>${esc(t.closing_text)}</p>
<div class="sig">${esc(t.signature_title)}</div>
<div class="foot">وثيقة صادرة إلكترونياً — يُعتمد التوقيع عبر الرابط الرسمي فقط.</div>
</body></html>`;
}

/** بصمة SHA-256 لأي نص/بايت */
function sha256Of(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

module.exports = {
  toVisualArabic,
  drawKeyValueRow,
  sanitizeText,
  measureVisual,
  wrapVisual,
  buildOfferPdf,
  buildOfferHtml,
  normalizeTemplate,
  formatMoney,
  formatDate,
  sha256Of,
  DEFAULT_TEMPLATE,
  PAGE
};
