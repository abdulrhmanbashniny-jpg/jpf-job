#!/usr/bin/env bash
# ==============================================================================
# ربط خادم Ollama المحلي على Ubuntu بحاوية Docker بأمان تام
# يسمح لحاوية المنصة (smart_hr_app) بالوصول إلى Ollama عبر host.docker.internal:11434
# مع حجب المنفذ 11434 عن الإنترنت الخارجي عبر جدار الحماية!
# ==============================================================================
set -euo pipefail

MODEL_TO_PULL="${1:-}"

echo "================================================================="
echo "🦙 إعداد جسر اتصال Ollama المحلي مع حاوية منصة التوظيف الذكية"
echo "================================================================="

if ! command -v ollama >/dev/null 2>&1; then
  echo "📥 برنامج Ollama غير مثبت حالياً — جاري تثبيته رسمياً..."
  curl -fsSL https://ollama.com/install.sh | sh
fi

echo "⚙️ ضبط خدمة Ollama للاستماع لجسر Docker المحلي..."
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/override.conf > /dev/null <<'EOF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_KEEP_ALIVE=15m"
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now ollama
sudo systemctl restart ollama

# تأمين المنفذ 11434 في UFW: السماح لشبكة Docker الداخلية وحجب الإنترنت العام
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow in on docker0 to any port 11434 proto tcp >/dev/null 2>&1 || true
  for br in $(ip -o link show | awk -F': ' '{print $2}' | grep '^br-' || true); do
    sudo ufw allow in on "$br" to any port 11434 proto tcp >/dev/null 2>&1 || true
  done
  sudo ufw deny 11434/tcp >/dev/null 2>&1 || true
fi

sleep 2
echo "📋 الموديلات المتوفرة حالياً على خادمك:"
ollama list || true

if [ -n "$MODEL_TO_PULL" ]; then
  echo "⬇️ جاري تحميل الموديل المطلوب ($MODEL_TO_PULL)..."
  ollama pull "$MODEL_TO_PULL"
fi

echo "================================================================="
echo "✅ أصبح خادم Ollama متصلاً بحاوية المنصة بأمان!"
echo "الآن افتح: Settings.dc.html -> اختر Ollama Local LLM -> اضغط (جلب الموديلات)"
echo "================================================================="
