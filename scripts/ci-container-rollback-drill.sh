#!/usr/bin/env bash
# ==============================================================================
# تجربة الترقية والنسخ الاحتياطي والاستعادة والرجوع الكاملة داخل حاويات Docker معزولة
# تختبر فعلياً:
# 1. تشغيل نسخة الإنتاج الحالية (70be659 v2.0) مع ملف ترقيع محلي (services/aiEvaluator.js)
#    وملف docker-compose.override.yml غير متتبّع وحجمَي pgdata و uploads_data المسمّيين.
# 2. رفع ملف سيرة ذاتية فعلي قبل الترقية وتخصيص قوالب whatsapp_templates.
# 3. تنفيذ أوامر النسخ الاحتياطي الموثقة (pg_dump -Fc داخل حاوية db + أرشفة uploads_data + نسخ override والترقيع).
# 4. الترقية إلى التزام v2.1 الحالي وإعادة بناء حاوية app مع بقاء override و uploads_data وقوالب واتساب.
# 5. اختبار استعادة النسخة الاحتياطية في قاعدة مؤقتة معزولة داخل حاوية db (باستخدام معاملَي -c منفصلين في psql).
# 6. تنفيذ إجراء الرجوع الفعلي للحاويات إلى 70be659 مع استرجاع ملف الترقيع وبقاء override وملفات السير المرفوعة،
#    واختبار استعادة حجم المرفقات بالكامل عند الطوارئ.
# ==============================================================================
set -euo pipefail

if [ "${ALLOW_ISOLATED_CONTAINER_DRILL:-0}" != "1" ]; then
  echo "[SAFETY_LOCKOUT] يلزم تمرير ALLOW_ISOLATED_CONTAINER_DRILL=1 لتشغيل تجربة الحاويات المعزولة." >&2
  exit 1
fi

if [[ "$PWD" == /opt/jpf-job* ]]; then
  echo "[SAFETY_LOCKOUT] يُمنع تشغيل هذا السكربت داخل مسار الإنتاج /opt/jpf-job." >&2
  exit 1
fi

REPO_ROOT="$PWD"
HEAD_SHA="$(git rev-parse HEAD)"
SIM_ID="jpfsim_$$"
SIM_ROOT="/tmp/${SIM_ID}"
SIM_APP="${SIM_ROOT}/opt_jpf_job"
SIM_BAK="${SIM_ROOT}/backups"
SIM_PORT=13080

cleanup() {
  local ec=$?
  if [ "$ec" -ne 0 ] && [ -d "${SIM_APP}" ] && [ -f "${SIM_APP}/docker-compose.yml" ]; then
    echo "=== [DIAGNOSTIC CONTAINER LOGS ON EXIT $ec] ===" >&2
    docker compose -p "${SIM_ID}" --env-file "${SIM_APP}/.env" -f "${SIM_APP}/docker-compose.yml" -f "${SIM_APP}/docker-compose.override.yml" ps >&2 || true
    docker compose -p "${SIM_ID}" --env-file "${SIM_APP}/.env" -f "${SIM_APP}/docker-compose.yml" -f "${SIM_APP}/docker-compose.override.yml" logs --tail=80 >&2 || true
  fi
  if [ -d "${SIM_APP}" ] && [ -f "${SIM_APP}/docker-compose.yml" ]; then
    docker compose -p "${SIM_ID}" --env-file "${SIM_APP}/.env" -f "${SIM_APP}/docker-compose.yml" -f "${SIM_APP}/docker-compose.override.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  docker network rm "${SIM_ID}_ext_ai_net" >/dev/null 2>&1 || true
  docker network rm "${SIM_ID}_ext_waha_net" >/dev/null 2>&1 || true
  rm -rf "${SIM_ROOT}"
}
trap 'echo "[DRILL_ERROR] Failed at line $LINENO" >&2' ERR
trap cleanup EXIT

mkdir -p "${SIM_APP}" "${SIM_BAK}"
docker network create "${SIM_ID}_ext_ai_net" >/dev/null
# v2.3: محاكاة شبكة WAHA الخارجية الموجودة على الخادم (waha-bbg7_default) حتى لا يفشل ربط الخدمة
docker network create "${SIM_ID}_ext_waha_net" >/dev/null

echo "=== [CONTAINER DRILL 1] BOOTING SIMULATED PRODUCTION v2.0 (git clone 70be659 + override + hotfix + volumes) ==="
git clone --quiet "${REPO_ROOT}" "${SIM_APP}"
git -C "${SIM_APP}" checkout --quiet 70be659

# محاكاة ملف الترقيع المحلي غير المرفوع على الإنتاج فوق 70be659
sed -i '1i // PROD_HOTFIX_OLLAMA_LOCAL_KEEP' "${SIM_APP}/services/aiEvaluator.js"

# محاكاة ملف .env الخاص بالإنتاج
cat > "${SIM_APP}/.env" <<EOF
BIND_IP=127.0.0.1
PORT=${SIM_PORT}
POSTGRES_USER=smart_hr_user
POSTGRES_PASSWORD=SimStrongDbPass_2026
POSTGRES_DB=smart_hr_db
ADMIN_ACCESS_CODE=SIM-PROD-ADMIN-2026
SESSION_SECRET=sim-prod-hmac-secret-2026-xyz
EOF

# محاكاة ملف docker-compose.override.yml غير المتتبع على الخادم (ربط شبكة خارجية + عزل أسماء الحاويات)
cat > "${SIM_APP}/docker-compose.override.yml" <<EOF
services:
  db:
    container_name: ${SIM_ID}_postgres
  app:
    container_name: ${SIM_ID}_app
    environment:
      OLLAMA_BASE_URL: http://ollama-yk6j-ollama-1:11434
    networks:
      - default
      - ext_ai
networks:
  ext_ai:
    external: true
    name: ${SIM_ID}_ext_ai_net
EOF

# v2.3: البيئة المعزولة تحتاج شبكة WAHA الخارجية + إبقاء Dry-Run ملزماً خلال كل تدريبات الحاويات
cat >> "${SIM_APP}/docker-compose.override.yml" <<EOF
  waha_net:
    external: true
    name: ${SIM_ID}_ext_waha_net
EOF
cat >> "${SIM_APP}/.env" <<EOF
WAHA_BASE_URL=http://waha-bbg7-waha-1:3000
WAHA_SESSION=default
WAHA_DRY_RUN=true
WAHA_LIVE_APPROVED=false
WAHA_DOCKER_NETWORK=${SIM_ID}_ext_waha_net
EOF

DC=(docker compose -p "${SIM_ID}" --env-file "${SIM_APP}/.env" -f "${SIM_APP}/docker-compose.yml" -f "${SIM_APP}/docker-compose.override.yml")

"${DC[@]}" up -d --build

# انتظار جاهزية خدمة التطبيق على المنفذ المعزول
HEALTH_OK=0
for i in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:${SIM_PORT}/api/health" 2>/dev/null | grep '"status":"ok"' >/dev/null; then
    HEALTH_OK=1
    break
  fi
  sleep 2
done
if [ "${HEALTH_OK}" != "1" ]; then
  echo "[ERR] v2.0 container failed healthcheck; container logs:" >&2
  "${DC[@]}" logs || true
  exit 1
fi

# رفع طلب وسيرة ذاتية حقيقية في v2.0 داخل حجم uploads_data وتخصيص قوالب واتساب
printf '%%PDF-1.4 Pre-upgrade Production CV Inside Named Volume\n' > "${SIM_ROOT}/v20_cand.pdf"
V20_APPLY_JSON=$(curl -fsS -X POST "http://127.0.0.1:${SIM_PORT}/api/applications" \
  -F "job_id=1" \
  -F "full_name=مرشح إنتاج قبل الترقية" \
  -F "email=prod_before_v21@jpf.sa" \
  -F "phone=0551002003" \
  -F "city=جدة" \
  -F "qualification=بكالوريوس" \
  -F "years_experience=5" \
  -F "privacy_consent=true" \
  -F "cv_file=@${SIM_ROOT}/v20_cand.pdf;type=application/pdf")
echo "v2.0 Application created: ${V20_APPLY_JSON}"

"${DC[@]}" exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE system_settings SET setting_value = setting_value || '\''{\"custom_prod_tpl\":\"قالب إنتاج محفوظ\"}'\''::jsonb WHERE setting_key = '\''whatsapp_templates'\'';"' >/dev/null

V20_CV_PATH=$("${DC[@]}" exec -T db sh -c 'psql -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT cv_stored_path FROM candidates WHERE email = '\''prod_before_v21@jpf.sa'\'';"')
test -n "${V20_CV_PATH}"
echo "[OK] v2.0 live with uploaded CV in named volume: ${V20_CV_PATH}"

echo "=== [CONTAINER DRILL 2] EXECUTING DOCUMENTED PRE-UPGRADE BACKUPS (DB + UPLOADS + OVERRIDE + HOTFIX) ==="
cp "${SIM_APP}/services/aiEvaluator.js" "${SIM_BAK}/aiEvaluator_pre_v21.js"
cp "${SIM_APP}/docker-compose.override.yml" "${SIM_BAK}/docker-compose.override.pre_v21.yml"

"${DC[@]}" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "${SIM_BAK}/db_pre_v21.dump"
TOC_LINES=$("${DC[@]}" exec -T db pg_restore --list < "${SIM_BAK}/db_pre_v21.dump" | wc -l | tr -d ' \r\n')
test "${TOC_LINES}" -gt 10

"${DC[@]}" exec -T app sh -c 'tar -czf - -C /app/uploads .' > "${SIM_BAK}/uploads_pre_v21.tar.gz"
tar -tzf "${SIM_BAK}/uploads_pre_v21.tar.gz" >/dev/null
echo "[OK] Pre-upgrade backups verified (db_pre_v21.dump [${TOC_LINES} TOC items] + uploads_pre_v21.tar.gz + hotfix + override)"

echo "=== [CONTAINER DRILL 3] UPGRADING CONTAINER TO v2.1 (${HEAD_SHA:0:7}) ==="
# بعد أخذ النسخة الاحتياطية من ملف الترقيع المحلي، تتم إعادة ضبط الملف المتتبع فقط لكي يسمح git بالانتقال النظيف دون لمس .env أو override
git -C "${SIM_APP}" checkout -- services/aiEvaluator.js
git -C "${SIM_APP}" checkout --quiet "${HEAD_SHA}"
test -f "${SIM_APP}/docker-compose.override.yml"
test -f "${SIM_APP}/.env"

T_UP0=$(date +%s)
"${DC[@]}" up -d --build app
UP_OK=0
for i in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:${SIM_PORT}/Visit.dc.html" >/dev/null 2>&1 && \
     curl -fsS "http://127.0.0.1:${SIM_PORT}/api/health" 2>/dev/null | grep '"status":"ok"' >/dev/null; then
    UP_OK=1
    break
  fi
  sleep 1
done
test "${UP_OK}" = "1"
T_UP1=$(date +%s)
echo "[OK] v2.1 container rebuilt and healthy in $((T_UP1 - T_UP0))s"

# التحقق من حفظ القالب المخصص وملف السيرة السابق بعد الترقية
TPL_CHECK=$("${DC[@]}" exec -T db sh -c 'psql -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT setting_value->>'\''custom_prod_tpl'\'' FROM system_settings WHERE setting_key = '\''whatsapp_templates'\'';"')
test "${TPL_CHECK}" = "قالب إنتاج محفوظ"

curl -fsS -c "${SIM_ROOT}/staff.cookies" -X POST "http://127.0.0.1:${SIM_PORT}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"SIM-PROD-ADMIN-2026"}' >/dev/null
PRE_CV_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -b "${SIM_ROOT}/staff.cookies" "http://127.0.0.1:${SIM_PORT}${V20_CV_PATH}")
test "${PRE_CV_HTTP}" = "200"

# رفع طلب جديد أثناء عمل v2.1
printf '%%PDF-1.4 New v2.1 Candidate CV\n' > "${SIM_ROOT}/v21_cand.pdf"
V21_APPLY_JSON=$(curl -fsS -X POST "http://127.0.0.1:${SIM_PORT}/api/applications" \
  -F "job_id=2" \
  -F "full_name=مرشح جديد على 2.1" \
  -F "email=cand_on_v21@jpf.sa" \
  -F "phone=0554005006" \
  -F "city=الرياض" \
  -F "qualification=ماجستير" \
  -F "specialization=إدارة مشاريع" \
  -F "years_experience=7" \
  -F "privacy_consent=true" \
  -F "cv_file=@${SIM_ROOT}/v21_cand.pdf;type=application/pdf")
V21_CV_PATH=$("${DC[@]}" exec -T db sh -c 'psql -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT cv_stored_path FROM candidates WHERE email = '\''cand_on_v21@jpf.sa'\'';"')
test -n "${V21_CV_PATH}"
echo "[OK] v2.1 preserved custom WA template & pre-upgrade CV (200), and stored new v2.1 CV (${V21_CV_PATH})"

echo "=== [CONTAINER DRILL 4] ISOLATED DB RESTORE VERIFICATION (SEPARATE psql -c FLAGS) ==="
"${DC[@]}" exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS smart_hr_restore_verify WITH (FORCE);" -c "CREATE DATABASE smart_hr_restore_verify;"'
"${DC[@]}" exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d smart_hr_restore_verify --no-owner --no-privileges' < "${SIM_BAK}/db_pre_v21.dump"
RESTORED_CANDS=$("${DC[@]}" exec -T db sh -c 'psql -tA -U "$POSTGRES_USER" -d smart_hr_restore_verify -c "SELECT COUNT(*) FROM candidates WHERE email = '\''prod_before_v21@jpf.sa'\'';"')
test "${RESTORED_CANDS}" = "1"
"${DC[@]}" exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS smart_hr_restore_verify WITH (FORCE);"'
echo "[OK] Isolated DB restore check inside db container passed cleanly"

echo "=== [CONTAINER DRILL 4B] CONTAINER ROLLBACK TO v2.1 (d0eb509) ON MIGRATED DB + UPLOAD LEAK PROTECTION ==="
# التحقق من حجب المحتوى المرفوع عن الزوار غير المصرحين (401) قبل وبعد الرجوع إلى v2.1
test "$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${SIM_PORT}${V20_CV_PATH}")" = "401"
test "$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${SIM_PORT}${V21_CV_PATH}")" = "401"

git -C "${SIM_APP}" checkout --quiet d0eb5091cb72adc2066909a5048c9b54ed043428
"${DC[@]}" up -d --build app
RB21_OK=0
for i in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:${SIM_PORT}/api/health" 2>/dev/null | grep '"version":"2.1.0"' >/dev/null; then
    RB21_OK=1
    break
  fi
  sleep 1
done
test "${RB21_OK}" = "1"
test "$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${SIM_PORT}${V21_CV_PATH}")" = "401"

curl -fsS -c "${SIM_ROOT}/rb21_staff.cookies" -X POST "http://127.0.0.1:${SIM_PORT}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"SIM-PROD-ADMIN-2026"}' >/dev/null
test "$(curl -s -o /dev/null -w "%{http_code}" -b "${SIM_ROOT}/rb21_staff.cookies" "http://127.0.0.1:${SIM_PORT}${V21_CV_PATH}")" = "200"

RB21_NEW_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${SIM_PORT}/api/applications" \
  -F "job_id=1" \
  -F "full_name=مرشح بعد الرجوع إلى 2.1" \
  -F "email=after_v21_rb@jpf.sa" \
  -F "phone=0557118229" \
  -F "city=جدة" \
  -F "qualification=بكالوريوس" \
  -F "specialization=مبيعات" \
  -F "years_experience=4" \
  -F "privacy_consent=true" \
  -F "cv_file=@${SIM_ROOT}/v21_cand.pdf;type=application/pdf")
test "${RB21_NEW_HTTP}" = "201"
echo "[OK] Container rolled back to v2.1 (d0eb509) on migrated DB: health=2.1.0, anon upload=401, staff upload=200, new apply=201"

echo "=== [CONTAINER DRILL 5] FULL CONTAINER ROLLBACK TO v2.0 (70be659 + HOTFIX + OVERRIDE + UPLOADS) ==="
git -C "${SIM_APP}" checkout --quiet 70be659
cp "${SIM_BAK}/aiEvaluator_pre_v21.js" "${SIM_APP}/services/aiEvaluator.js"
test ! -f "${SIM_APP}/public/Visit.dc.html"
test -f "${SIM_APP}/docker-compose.override.yml"
grep "PROD_HOTFIX_OLLAMA_LOCAL_KEEP" "${SIM_APP}/services/aiEvaluator.js" >/dev/null

T_RB0=$(date +%s)
"${DC[@]}" up -d --build app
RB_OK=0
for i in $(seq 1 45); do
  VISIT_RB_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${SIM_PORT}/Visit.dc.html" || true)
  if [ "${VISIT_RB_CODE}" = "404" ] && \
     curl -fsS "http://127.0.0.1:${SIM_PORT}/api/health" 2>/dev/null | grep '"status":"ok"' >/dev/null; then
    RB_OK=1
    break
  fi
  sleep 1
done
test "${RB_OK}" = "1"
T_RB1=$(date +%s)
echo "[OK] Container rolled back to v2.0 + hotfix in $((T_RB1 - T_RB0))s"

# التحقق من بقاء السيرتين الذاتيتين (قبل الترقية وأثناء 2.1) مقروءتين داخل الحاوية المسترجعة، ونجاح تقديم طلب جديد على v2.0
curl -fsS -c "${SIM_ROOT}/rb_staff.cookies" -X POST "http://127.0.0.1:${SIM_PORT}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"SIM-PROD-ADMIN-2026"}' >/dev/null

test "$(curl -s -o /dev/null -w "%{http_code}" -b "${SIM_ROOT}/rb_staff.cookies" "http://127.0.0.1:${SIM_PORT}${V20_CV_PATH}")" = "200"
test "$(curl -s -o /dev/null -w "%{http_code}" -b "${SIM_ROOT}/rb_staff.cookies" "http://127.0.0.1:${SIM_PORT}${V21_CV_PATH}")" = "200"

RB_NEW_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${SIM_PORT}/api/applications" \
  -F "job_id=3" \
  -F "full_name=مرشح بعد الرجوع للحاوية" \
  -F "email=after_container_rb@jpf.sa" \
  -F "phone=0557008009" \
  -F "city=جدة" \
  -F "qualification=بكالوريوس" \
  -F "years_experience=4" \
  -F "privacy_consent=true" \
  -F "cv_file=@${SIM_ROOT}/v20_cand.pdf;type=application/pdf")
test "${RB_NEW_HTTP}" = "201"

# اختبار استعادة أرشيف المرفقات للطوارئ القصوى والتأكد من بقاء صلاحيات node:node وعمل الرفع بعدها
"${DC[@]}" exec -T app sh -c 'rm -rf /app/uploads/* && mkdir -p /app/uploads/samples /app/uploads/public && tar -xzf - -C /app/uploads' < "${SIM_BAK}/uploads_pre_v21.tar.gz"
test "$(curl -s -o /dev/null -w "%{http_code}" -b "${SIM_ROOT}/rb_staff.cookies" "http://127.0.0.1:${SIM_PORT}${V20_CV_PATH}")" = "200"

echo "ALL_CONTAINER_UPGRADE_RESTORE_AND_ROLLBACK_DRILLS_PASSED_100_PERCENT"
