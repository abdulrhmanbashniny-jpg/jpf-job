#!/usr/bin/env bash
# scripts/ci-v25-steps.sh — خطوات v2.5 كسكربت مستقل
# ---------------------------------------------------------------------------------
# نفس مبرّر v2.4: لا نعدّل .github/workflows/ci.yml (يتطلب صلاحية workflow خاصة).
# هذا السكربت يُشغّل خطوتَي v2.5 من داخل المستودع ويمكن استدعاؤه يدوياً أو من أي runner.
#
# الاستخدام:
#   bash scripts/ci-v25-steps.sh                 # الثابتة + الحيّة
#   bash scripts/ci-v25-steps.sh --static-only   # الفحص التعاقدي فقط (بلا قاعدة/متصفح)
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== [CI v2.5] 1/2 الفحص التعاقدي (verify:v25) ==="
node scripts/verify-v25.js

if [ "${1:-}" = "--static-only" ]; then
  echo "=== [CI v2.5] تم تخطي الفحص الحيّ بناءً على الطلب ==="
  exit 0
fi

echo
echo "=== [CI v2.5] 2/2 الفحص الحيّ على قاعدة معزولة (verify:v25:live) ==="

# حواجز الأمان: يجب أن ترفض الصيغ غير المصرح بها قبل التشغيل الفعلي
if ALLOW_ISOLATED_DRILL=0 node scripts/verify-v25-live.js >/dev/null 2>&1; then
  echo "FAIL: شُغّل الفحص الحيّ بلا ALLOW_ISOLATED_DRILL=1"; exit 1
fi
if ALLOW_ISOLATED_DRILL=1 NODE_ENV=production \
   DRILL_PG_ADMIN_URL="${DRILL_PG_ADMIN_URL:-postgresql://postgres:postgres@127.0.0.1:5432/postgres}" \
   node scripts/verify-v25-live.js >/dev/null 2>&1; then
  echo "FAIL: شُغّل الفحص الحيّ في وضع production"; exit 1
fi
# قاعدة غير محلية يجب أن تُرفض
if ALLOW_ISOLATED_DRILL=1 \
   DRILL_PG_ADMIN_URL="postgresql://postgres:postgres@db.example.com:5432/postgres" \
   node scripts/verify-v25-live.js >/dev/null 2>&1; then
  echo "FAIL: شُغّل الفحص الحيّ على قاعدة غير محلية"; exit 1
fi
echo "✓ حواجز الأمان الثلاثة تعمل (بلا تصريح / production / قاعدة بعيدة)"

ALLOW_ISOLATED_DRILL=1 \
DRILL_PG_ADMIN_URL="${DRILL_PG_ADMIN_URL:-postgresql://postgres:postgres@127.0.0.1:5432/postgres}" \
  node scripts/verify-v25-live.js

echo
echo "CI_V25_STEPS_PASSED"
