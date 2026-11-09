/* =========================================================================
   منصة التوظيف الذكية — الدوال المشتركة ومكونات التنقل الموحدة
   أمان المعلومات: لا يتم تخزين أي مفاتيح أو بيانات حساسة في المتصفح مطلقاً
   ========================================================================= */

const SmartHR = (() => {
  const DEPT_COLORS = {
    'الإنتاج': '#C8553D',
    'المبيعات': '#E0A21B',
    'المشاريع': '#3B5B78',
    'الجودة': '#2F5D50',
    'المستودعات': '#7A5C43'
  };

  const STATUS_MAP = {
    assessment_pending: { label: 'بانتظار الاختبار', cls: 'badge-saffron' },
    passed_assessment: { label: 'مجتاز للاختبار', cls: 'badge-olive' },
    failed_assessment: { label: 'لم يجتز (أقل من 60%)', cls: 'badge-terracotta' },
    under_review: { label: 'قيد تقييم اللجنة', cls: 'badge-charcoal' },
    interview_scheduled: { label: 'مقابلة مجدولة', cls: 'badge-olive' },
    interviewed: { label: 'تمت المقابلة', cls: 'badge-olive' },
    offered: { label: 'عرض وظيفي معتمد', cls: 'badge-olive' },
    rejected: { label: 'معتذر عنه', cls: 'badge-terracotta' }
  };

  const BOOKING_MAP = {
    scheduled: { label: 'مجدولة', cls: 'badge-saffron' },
    invitation_sent: { label: 'أُرسلت الدعوة', cls: 'badge-charcoal' },
    confirmed: { label: 'مؤكدة الحضور', cls: 'badge-olive' },
    completed: { label: 'مكتملة', cls: 'badge-olive' },
    rescheduled: { label: 'مُعاد جدولتها', cls: 'badge-saffron' },
    cancelled: { label: 'ملغاة', cls: 'badge-terracotta' },
    no_show: { label: 'لم يحضر', cls: 'badge-terracotta' }
  };

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function deptColor(dept) {
    return DEPT_COLORS[dept] || '#C8553D';
  }

  function statusBadge(status) {
    const info = STATUS_MAP[status] || { label: status || 'غير محدد', cls: 'badge-charcoal' };
    return `<span class="badge ${info.cls}">${escapeHtml(info.label)}</span>`;
  }

  function bookingBadge(status) {
    const info = BOOKING_MAP[status] || { label: status || 'مجدولة', cls: 'badge-charcoal' };
    return `<span class="badge ${info.cls}">${escapeHtml(info.label)}</span>`;
  }

  function formatDate(dateVal) {
    if (!dateVal) return '—';
    const d = new Date(dateVal);
    if (Number.isNaN(d.getTime())) return String(dateVal).slice(0, 10);
    return d.toLocaleDateString('ar-SA', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatTime(timeStr) {
    if (!timeStr) return '—';
    const clean = String(timeStr).slice(0, 5);
    const [hStr, mStr] = clean.split(':');
    const h = parseInt(hStr, 10);
    if (Number.isNaN(h)) return clean;
    const period = h >= 12 ? 'م' : 'ص';
    const h12 = h % 12 || 12;
    return `${String(h12).padStart(2, '0')}:${mStr} ${period}`;
  }

  function showToast(message, type = 'info') {
    let stack = document.getElementById('toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toast-stack';
      stack.className = 'toast-stack';
      document.body.appendChild(stack);
    }
    const el = document.createElement('div');
    el.className = `toast-msg ${type}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s ease';
      setTimeout(() => el.remove(), 260);
    }, 4200);
  }

  async function apiFetch(url, options = {}) {
    const res = await fetch(url, options);
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : { error: await res.text() };
    if (!res.ok) {
      throw new Error(data.error || `خطأ في الاتصال بالخادم (${res.status})`);
    }
    return data;
  }

  function renderPortalHeader(activeKey = 'home') {
    const mount = document.getElementById('portal-header-mount');
    if (!mount) return;
    mount.innerHTML = `
      <header class="portal-header">
        <div class="portal-header-inner">
          <a href="index.html" class="brand-block">
            <div class="brand-swatch">ر</div>
            <div>
              <span class="brand-title">رُواء للكفاءات والتوظيف الذكي</span>
              <span class="brand-subtitle">قطاع الدهانات والصناعات الإبداعية والحلول الهندسية</span>
            </div>
          </a>
          <nav class="portal-nav" aria-label="التنقل الرئيسي">
            <a href="index.html" class="${activeKey === 'home' ? 'active' : ''}">الوظائف المتاحة</a>
            <a href="index.html#how-it-works" class="${activeKey === 'steps' ? 'active' : ''}">رحلة التقديم</a>
            <a href="Job.dc.html?code=SL-204" class="${activeKey === 'job' ? 'active' : ''}">تفاصيل الوظائف</a>
            <a href="Dashboard.dc.html" class="committee-switch">لوحة لجنة التوظيف ←</a>
          </nav>
        </div>
      </header>
    `;
  }

  function renderPortalFooter() {
    const mount = document.getElementById('portal-footer-mount');
    if (!mount) return;
    mount.innerHTML = `
      <footer class="portal-footer">
        <div class="container-1440" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:18px;">
          <div>
            <strong style="color:#FFF;font-family:var(--font-heading);">منصة رُواء للتوظيف الذكي (Smart HR Platform)</strong>
            <p style="font-size:13px;margin-top:4px;">فرز عادل بتقنية الفحص الأعمى (Blind AI Screening) + تقييم لجنة التوظيف الموزون</p>
          </div>
          <div style="display:flex;gap:18px;font-size:13px;align-items:center;">
            <a href="index.html" style="color:#E0A21B;">بوابة المتقدمين</a>
            <span>|</span>
            <a href="Dashboard.dc.html" style="color:#FFF;">بوابة اللجنة</a>
            <span>|</span>
            <a href="System.dc.html" style="color:#CFD3DA;">المعمارية والحوكمة</a>
          </div>
        </div>
      </footer>
    `;
  }

  function renderAdminSidebar(activePage = 'dashboard') {
    const mount = document.getElementById('admin-sidebar-mount');
    if (!mount) return;

    const links = [
      { key: 'dashboard', href: 'Dashboard.dc.html', icon: '📊', label: 'نظرة عامة (Dashboard)', section: 'العمليات والفرز' },
      { key: 'jobbuilder', href: 'JobBuilder.dc.html', icon: '🎨', label: 'إعداد الوظائف وبرومنت AI' },
      { key: 'profile', href: 'CandidateProfile.dc.html', icon: '👤', label: 'ملف المرشح وتقييم اللجنة' },
      { key: 'ranking', href: 'Ranking.dc.html', icon: '🏆', label: 'الترتيب الموزون (40/60)' },
      { key: 'scheduler', href: 'Scheduler.dc.html', icon: '📅', label: 'جدولة المقابلات الذكية', section: 'المقابلات والتواصل' },
      { key: 'interviews', href: 'Interviews.dc.html', icon: '💬', label: 'طابور رسائل واتساب الهجين' },
      { key: 'aiengine', href: 'AIEngine.dc.html', icon: '🧠', label: 'محرك التحليل والفحص الأعمى', section: 'الحوكمة والتقنية' },
      { key: 'settings', href: 'Settings.dc.html', icon: '⚙️', label: 'الإعدادات ومزودو الذكاء' },
      { key: 'system', href: 'System.dc.html', icon: '🗄️', label: 'معمارية النظام وقاعدة البيانات' }
    ];

    let menuHtml = '';
    for (const item of links) {
      if (item.section) {
        menuHtml += `<div class="sidebar-section-label">${item.section}</div>`;
      }
      menuHtml += `
        <a href="${item.href}" class="sidebar-link ${activePage === item.key ? 'active' : ''}">
          <span class="sidebar-link-main">
            <span class="sidebar-icon">${item.icon}</span>
            <span>${item.label}</span>
          </span>
        </a>
      `;
    }

    mount.outerHTML = `
      <aside class="admin-sidebar">
        <a href="Dashboard.dc.html" class="sidebar-brand">
          <div class="brand-swatch">ر</div>
          <div>
            <div style="font-family:var(--font-heading);font-weight:700;font-size:15px;color:#FFF;">لجنة التوظيف المركزية</div>
            <div class="mono" style="font-size:11px;color:#E0A21B;">smart_hr_db • PostgreSQL</div>
          </div>
        </a>
        <nav class="sidebar-menu" aria-label="قائمة لوحة التحكم">
          ${menuHtml}
        </nav>
        <div class="sidebar-footer">
          <div style="background:rgba(255,255,255,0.06);padding:12px;border-radius:10px;font-size:12px;color:#B8BCC4;">
            <div style="color:#FFF;font-weight:600;margin-bottom:3px;">🔒 وضع الحوكمة الآمن</div>
            المفاتيح السرية مُدارة حصراً في الخادم عبر <span class="mono" style="color:#E0A21B;">.env</span>
          </div>
          <a href="index.html" class="btn btn-outline btn-sm" style="background:transparent;color:#FFF;border-color:rgba(255,255,255,0.22);width:100%;">
            ↗ معاينة بوابة المتقدمين
          </a>
        </div>
      </aside>
    `;
  }

  return {
    escapeHtml,
    deptColor,
    statusBadge,
    bookingBadge,
    formatDate,
    formatTime,
    showToast,
    apiFetch,
    renderPortalHeader,
    renderPortalFooter,
    renderAdminSidebar
  };
})();
