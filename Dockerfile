FROM node:20-alpine

WORKDIR /app

# تثبيت الاعتماديات الإنتاجية فقط
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# نسخ ملفات المشروع
COPY database ./database
COPY services ./services
COPY scripts ./scripts
COPY public ./public
COPY server.js ./

# إنشاء مجلد المرفقات (الخاص للمرشحين والعام لصورة مدخل المقر) ومنح الصلاحيات لمستخدم غير جذري للأمان
RUN mkdir -p /app/uploads/samples /app/uploads/public && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
