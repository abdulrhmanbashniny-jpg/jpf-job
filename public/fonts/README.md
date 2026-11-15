# الخطوط العربية المضمَّنة في توليد PDF (v2.5)

## لماذا هذه الخطوط مضمَّنة داخل المستودع؟
توليد عرض وظيفي عربي سليم يحتاج خطاً يغطي **Arabic Presentation Forms-B**
(النطاق U+FB50–U+FEFF). معظم الخطوط العربية الحديثة (Cairo, Tajawal, IBM Plex Arabic)
تعتمد على OpenType shaping ولا تتضمن صور الحروف المتصلة في جدول cmap، فتظهر
مربعات منقّطة (dotted circle) أو حروف مفقودة داخل PDF.

## الخطوط
| الملف | العائلة | الترخيص | التغطية |
|---|---|---|---|
| `Amiri-Regular.ttf` | Amiri | SIL Open Font License (OFL) 1.1 | 1699 محرفاً — يشمل Presentation Forms-B كاملة |
| `NotoNaskhArabic-Variable.ttf` | Noto Naskh Arabic | SIL Open Font License (OFL) 1.1 | 1551 محرفاً — بديل احتياطي |

المصدر: Google Fonts (`github.com/google/fonts/tree/main/ofl/amiri` و `ofl/notonaskharabic`).

## قيود تقنية مُثبتة بالاختبار
1. **`subset: true` يفقد المحارف** عند استخدام صور الحروف ⇒ التضمين يجب أن يكون كاملاً.
2. **الخط القياسي (Helvetica) غير موثوق** في الحاويات/العارضات ⇒ نستخدم الخط المضمَّن لكل النص.
3. **التواريخ والأرقام تُرسم كتدفق LTR منفصل** لأن خوارزمية Bidi تُفتّت `2026-11-14`
   عند الشُرَط وتُعيد ترتيب المجموعات (خطأ ظهر فعلياً: `6202-11-41`).

## الترقية المستقبلية
لاستبدال الخط: ضع ملفاً `.ttf` يغطي Presentation Forms-B في هذا المجلد، وحدّث المسار
في `services/offerPdf.js` (`FONT_FILES.arabic`). يتحقق `verify:v25` من التغطية تلقائياً.
