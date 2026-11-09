#!/usr/bin/env bash
# ==============================================================================
# سكريبت النشر والتحديث التلقائي v2.0 على خادم VPS — مشروع jpf-job
# يدعم الترقية السلسة بدون فقدان البيانات + Ollama + RBAC
# ==============================================================================
set -euo pipefail

REPO_URL="https://github.com/abdulrhmanbashniny-jpg/jpf-job.git"
APP_DIR="/opt/jpf-job"

echo "🚀 بدء تجهيز/ترقية منصة التوظيف الذكية v2.0 (jpf-job)..."

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
  SESS_SEC="$(openssl rand -hex 32)"
  cat > .env <<EOF
PORT=3000
HOST=0.0.0.0
BIND_IP=0.0.0.0
NODE_ENV=production
POSTGRES_USER=smart_hr_user
POSTGRES_PASSWORD=${DB_PASS}
POSTGRES_DB=smart_hr_db
AI_DEFAULT_PROVIDER=smart-rubric
OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_MODEL=qwen2.5:7b
OPENAI_API_KEY=
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
DEEPSEEK_API_KEY=
MAX_UPLOAD_MB=10
ADMIN_ACCESS_CODE=${ADMIN_CODE}
SESSION_SECRET=${SESS_SEC}
EOF
  chmod 600 .env
else
  # إضافة المتغيرات الجديدة في الإصدار 2.0 تلقائياً دون المساس بكلمات المرور الحالية
  grep -q "^OLLAMA_BASE_URL=" .env || echo "OLLAMA_BASE_URL=http://host.docker.internal:11434" >> .env
  grep -q "^OLLAMA_MODEL=" .env || echo "OLLAMA_MODEL=qwen2.5:7b" >> .env
  grep -q "^SESSION_SECRET=" .env || echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
fi

echo "🏗️ إعادة بناء وتشغيل الحاويات (مع الحفاظ الكامل على قاعدة البيانات والمرفقات)..."
docker compose up -d --build

echo "⏳ التحقق من جاهزية الخدمة وقاعدة البيانات..."
for i in {1..15}; do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo "✅ المنصة v2.0 تعمل بنجاح كامل!"
    curl -s http://127.0.0.1:3000/api/health
    echo ""
    ADMIN_PWD=$(grep "^ADMIN_ACCESS_CODE=" .env | cut -d'=' -f2-)
    echo "================================================================="
    echo "🔑 بيانات دخول المدير العام للجنة التوظيف (/Login.dc.html):"
    echo "   اسم المستخدم : admin"
    echo "   كلمة المرور  : ${ADMIN_PWD}"
    echo "================================================================="
    exit 0
  fi
  sleep 2
done

echo "⚠️ يرجى مراجعة السجلات عبر: docker compose logs -f"
exit 1
