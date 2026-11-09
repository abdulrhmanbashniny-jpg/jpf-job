#!/usr/bin/env bash
# ==============================================================================
# ربط النطاق الرسمي (Custom Domain) + شهادة أمان SSL مجانية (Let's Encrypt)
# متوافق مع Ubuntu 22.04 / 24.04 LTS — منصة التوظيف الذكية (jpf-job)
# طريقة التشغيل:
#   sudo bash /opt/jpf-job/setup-domain.sh jobs.yourdomain.com admin@yourdomain.com
# ==============================================================================
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
APP_DIR="${APP_DIR:-/opt/jpf-job}"

echo "================================================================="
echo "🌐 إعداد النطاق المخصص وشهادة HTTPS (Nginx + Certbot SSL)"
echo "================================================================="

if [ -z "$DOMAIN" ]; then
  read -r -p "أدخل اسم النطاق أو النطاق الفرعي (مثال: jobs.yourdomain.com): " DOMAIN
fi

if [ -z "$EMAIL" ]; then
  read -r -p "أدخل البريد الإلكتروني لإشعارات تجديد شهادة SSL: " EMAIL
fi

if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
  echo "❌ خطأ: يجب إدخال اسم النطاق والبريد الإلكتروني."
  exit 1
fi

echo "📦 [1/5] تثبيت Nginx و Certbot..."
sudo apt-get update -y
sudo apt-get install -y nginx certbot python3-certbot-nginx ufw

echo "⚙️ [2/5] إنشاء ملف إعداد Reverse Proxy للنطاق ($DOMAIN)..."
NGINX_CONF="/etc/nginx/sites-available/jpf-job"

sudo tee "$NGINX_CONF" > /dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    # السماح برفع السير الذاتية والمرفقات حتى 15 ميجابايت
    client_max_body_size 15M;

    # حماية الهيدرات الأمنية
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;

        # مهلة ممتدة لدعم تحليل موديلات Ollama المحلية بدون انقطاع
        proxy_connect_timeout 60s;
        proxy_send_timeout 120s;
        proxy_read_timeout 120s;
    }
}
EOF

sudo ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/jpf-job
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx

echo "🔒 [3/5] قصر منفذ Docker 3000 على الاتصال المحلي فقط (127.0.0.1) خلف Nginx..."
if [ -f "$APP_DIR/.env" ]; then
  if grep -q "^BIND_IP=" "$APP_DIR/.env"; then
    sudo sed -i 's/^BIND_IP=.*/BIND_IP=127.0.0.1/' "$APP_DIR/.env"
  else
    echo "BIND_IP=127.0.0.1" | sudo tee -a "$APP_DIR/.env" > /dev/null
  fi
  (cd "$APP_DIR" && sudo docker compose up -d)
fi

echo "🛡️ [4/5] ضبط جدار الحماية UFW..."
sudo ufw allow OpenSSH >/dev/null 2>&1 || true
sudo ufw allow 'Nginx Full' >/dev/null 2>&1 || true
# منع الوصول الخارجي المباشر لمنفذ Ollama 11434 مع بقائه متاحاً للحاوية محلياً
sudo ufw deny 11434/tcp >/dev/null 2>&1 || true

echo "🔐 [5/5] إصدار شهادة HTTPS رسمية من Let's Encrypt وتفعيل التحويل التلقائي..."
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect

echo "================================================================="
echo "✅ تم ربط النطاق وتفعيل HTTPS بنجاح!"
echo "🌍 بوابة المتقدمين العامة : https://${DOMAIN}"
echo "🔑 بوابة دخول اللجنة      : https://${DOMAIN}/Login.dc.html"
echo "================================================================="
