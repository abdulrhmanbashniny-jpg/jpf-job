#!/usr/bin/env bash
# scripts/ci-v24-steps.sh — خطوات v2.4 كسكربت مستقل
# ---------------------------------------------------------------------------------
# السبب: عدّل GitHub Actions (.github/workflows/ci.yml) يتطلب صلاحية workflow خاصة
# لا يملكها اعتماد النشر. هذا السكربت يُشغّل نفس خطوتي v2.4 من داخل المستودع
# دون أي تعديل على ملفات workflow، ويمكن استدعاؤه يدوياً أو من أي runner خارجي.
#
# الاستخدام:
#   bash scripts/ci-v24-steps.sh                 # الخطوتان (ثابتة + حيّة)
#   bash scripts/ci-v24-steps.sh --static-only   # الفحص التعاقدي فقط
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== [CI v2.4] 1/2 الفحص التعاقدي (verify:v24) ==="
JITSI_ENABLED="${JITSI_ENABLED:-true}" \
JITSI_DOMAIN="${JITSI_DOMAIN:-meet.drill.invalid}" \
  node scripts/verify-v24.js

if [ "${1:-}" = "--static-only" ]; then
  echo "=== [CI v2.4] تم تخطي الفحص الحيّ بناءً على الطلب ==="
  exit 0
fi

echo
echo "=== [CI v2.4] 2/2 الفحص الحيّ على قاعدة معزولة (verify:v24:live) ==="

# حواجز الأمان: يجب أن ترفض الصيغ غير المصرح بها قبل التشغيل
if ALLOW_ISOLATED_DRILL=0 node scripts/verify-v24-live.js >/dev/null 2>&1; then
  echo "FAIL: شُغّل الفحص الحيّ بلا ALLOW_ISOLATED_DRILL=1"; exit 1
fi
if ALLOW_ISOLATED_DRILL=1 NODE_ENV=production \
   DRILL_PG_ADMIN_URL="${DRILL_PG_ADMIN_URL:-postgresql://postgres:postgres@127.0.0.1:5432/postgres}" \
   node scripts/verify-v24-live.js >/dev/null 2>&1; then
  echo "FAIL: شُغّل الفحص الحيّ في وضع production"; exit 1
fi

ALLOW_ISOLATED_DRILL=1 \
DRILL_PG_ADMIN_URL="${DRILL_PG_ADMIN_URL:-postgresql://postgres:postgres@127.0.0.1:5432/postgres}" \
  node scripts/verify-v24-live.js

echo
echo "CI_V24_STEPS_PASSED"
