#!/usr/bin/env bash
# ==============================================================================
# سكريبت النشر والتحديث التلقائي على خادم VPS — مشروع jpf-job
# المستودع: https://github.com/abdulrhmanbashniny-jpg/jpf-job
# ==============================================================================
set -euo pipefail

REPO_URL="https://github.com/abdulrhmanbashniny-jpg/jpf-job.git"
APP_DIR="/opt/jpf-job"

echo "🚀 بدء تجهيز ونشر منصة التوظيف الذكية (jpf-job)..."

if ! command -v docker >/dev/null 2>&1; then
  echo "📦 تثبيت Docker Engine و Docker Compose..."
  curl -fsSL https://get.docker.com | sh
fi

if [ ! -d "$APP_DIR/.git" ]; then
  echo "📥 استنساخ المستودع من $REPO_URL إلى $APP_DIR..."
  git clone "$REPO_URL" "$APP_DIR"
else
  echo "🔄 سحب آخر التحديثات من الفرع الرئيسي (main)..."
  git -C "$APP_DIR" pull origin main
fi

cd "$APP_DIR"

if [ ! -f ".env" ]; then
  echo "🔐 إنشاء ملف .env آمن للإنتاج..."
  DB_PASS="$(openssl rand -hex 18)"
  ADMIN_CODE="JPF-$(openssl rand -hex 4 | tr '[:lower:]' '[:upper:]')"
  cat > .env <<EOF
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
POSTGRES_USER=smart_hr_user
POSTGRES_PASSWORD=${DB_PASS}
POSTGRES_DB=smart_hr_db
AI_DEFAULT_PROVIDER=smart-rubric
OPENAI_API_KEY=
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
DEEPSEEK_API_KEY=
MAX_UPLOAD_MB=10
ADMIN_ACCESS_CODE=${ADMIN_CODE}
EOF
  chmod 600 .env
  echo "✅ تم إنشاء ملف .env بصلاحيات مقيدة (600)."
fi

echo "🏗️ بناء وتشغيل الحاويات (PostgreSQL 17 + Node.js App)..."
docker compose up -d --build

echo "⏳ التحقق من جاهزية الخدمة وقاعدة البيانات..."
for i in {1..15}; do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo "✅ المنصة تعمل بنجاح كامل!"
    curl -s http://127.0.0.1:3000/api/health
    echo ""
    exit 0
  fi
  sleep 2
done

echo "⚠️ يرجى مراجعة السجلات عبر: docker compose logs -f"
exit 1
