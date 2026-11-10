/* =========================================================================
   منصة التوظيف الذكية v2.0 — الدوال المشتركة، الحوكمة، ونظام الصلاحيات (RBAC)
   أمان المعلومات: لا يتم تخزين أي مفاتيح أو جلسات في المتصفح (HttpOnly Cookies)
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

  function punctualityBadge(minutesVal) {
    if (minutesVal === null || minutesVal === undefined || Number.isNaN(Number(minutesVal))) return '';
    const m = Number(minutesVal);
    if (m > 0) return `<span class="badge badge-olive">⏱ حضر مبكراً بـ ${m} د</span>`;
    if (m === 0) return `<span class="badge badge-olive">⏱ حضر في الموعد تماماً</span>`;
    return `<span class="badge badge-terracotta">⏱ تأخر ${Math.abs(m)} د</span>`;
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
    const extraHeaders = { ...(options.headers || {}) };
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const ctFromUrl = urlParams.get('ct');
      if (ctFromUrl && !extraHeaders['x-candidate-token']) {
        extraHeaders['x-candidate-token'] = ctFromUrl;
      }
    } catch (_e) {}

    const headers = options.body instanceof FormData
      ? extraHeaders
      : { 'Content-Type': 'application/json', ...extraHeaders };
    const res = await fetch(url, { ...options, headers });
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : { error: await res.text() };

    if (res.status === 401 && document.querySelector('.admin-shell')) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.replace(`Login.dc.html?next=${next}`);
      throw new Error('انتهت جلسة العمل، يرجى تسجيل الدخول مجدداً.');
    }

    if (!res.ok) {
      const err = new Error(data.error || `خطأ في الاتصال بالخادم (${res.status})`);
      err.status = res.status;
      err.code = data.code;
      err.data = data;
      throw err;
    }

    // إزالة رمز الاستعادة من شريط العنوان بعد تثبيت كوكي الجلسة الآمن HttpOnly
    try {
      const currentUrl = new URL(window.location.href);
      if (currentUrl.searchParams.has('ct')) {
        currentUrl.searchParams.delete('ct');
        window.history.replaceState({}, '', currentUrl.pathname + currentUrl.search);
      }
    } catch (_e) {}

    return data;
  }

  function renderCandidateVerifyCard(mountEl, initialRef = '', onVerified, hrPhone = '966550000000') {
    if (!mountEl) return;
    const cleanHr = String(hrPhone || '966550000000').replace(/\D/g, '');
    const waHelpText = encodeURIComponent(
      `السلام عليكم فريق التوظيف، أرغب في استعادة رابط الدخول لطلبي رقم (${initialRef || 'APP-2026-XXXX'}) من رقمي المسجل لديكم.`
    );
    mountEl.innerHTML = `
      <div class="card" style="max-width:560px;margin:20px auto;text-align:center;padding:34px;">
        <div style="font-size:34px;margin-bottom:8px;">🔑</div>
        <h2 style="font-size:21px;margin-bottom:8px;">إثبات ملكية طلب التوظيف</h2>
        <p style="color:var(--text-secondary);font-size:13.5px;margin-bottom:20px;line-height:1.75;">
          حفاظاً على سرية الطلبات ومنع انتحال الهوية، يرجى إدخال الرقم المرجعي مع <strong>مفتاح الدخول السري (Access Key)</strong> الصادر لك عند التقديم.
        </p>
        <form id="cand-verify-form" style="text-align:right;max-width:420px;margin:0 auto;">
          <div class="form-group" style="margin-bottom:12px;">
            <label class="form-label">الرقم المرجعي للطلب *</label>
            <input type="text" id="cvf-ref" class="form-control mono" placeholder="APP-2026-1001" value="${escapeHtml(initialRef)}" required />
          </div>
          <div class="form-group" style="margin-bottom:16px;">
            <label class="form-label">مفتاح الدخول السري (Access Key) *</label>
            <input type="text" id="cvf-key" class="form-control mono" dir="ltr" placeholder="JPFK-XXXX-XXXX-XXXX-XXXX" autocomplete="off" required />
          </div>
          <button type="submit" id="cvf-submit" class="btn btn-primary" style="width:100%;">تحقق من المفتاح ومتابعة ←</button>
        </form>
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border);font-size:12.5px;color:var(--text-secondary);">
          فقدت مفتاح الدخول السري؟
          <a href="https://wa.me/${cleanHr}?text=${waHelpText}" target="_blank" rel="noopener" style="color:var(--olive);font-weight:700;text-decoration:underline;">
            اطلب إرسال رابط استعادة لجوالك المسجل عبر واتساب ↗
          </a>
        </div>
      </div>
    `;
    const form = mountEl.querySelector('#cand-verify-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = mountEl.querySelector('#cvf-submit');
      const refVal = mountEl.querySelector('#cvf-ref').value.trim();
      const keyVal = mountEl.querySelector('#cvf-key').value.trim();
      btn.disabled = true;
      btn.textContent = 'جاري التحقق التشفيري...';
      try {
        const vRes = await apiFetch('/api/public/candidate-verify', {
          method: 'POST',
          body: JSON.stringify({ reference_no: refVal, access_key: keyVal })
        });
        try {
          sessionStorage.setItem('jpf_access_key_' + vRes.reference_no, keyVal.toUpperCase());
        } catch (_e) {}
        showToast('✓ تم إثبات ملكية الطلب بنجاح', 'success');
        if (typeof onVerified === 'function') {
          onVerified(vRes.reference_no);
        } else {
          window.location.search = `?ref=${encodeURIComponent(vRes.reference_no)}`;
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'تحقق من المفتاح ومتابعة ←';
        showToast(err.message, 'error');
      }
    });
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (_e) {}
    window.location.replace('Login.dc.html');
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
            <a href="Login.dc.html" class="committee-switch" title="دخول مخصص لأعضاء اللجنة المصرح لهم">🔒 دخول اللجنة</a>
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
            <strong style="color:#FFF;font-family:var(--font-heading);">منصة رُواء للتوظيف الذكي (Smart HR Platform v2.0)</strong>
            <p style="font-size:13px;margin-top:4px;">فرز عادل بتقنية الفحص الأعمى (Blind AI Screening + Ollama) + تقييم لجنة التوظيف الموزون</p>
          </div>
          <div style="display:flex;gap:18px;font-size:13px;align-items:center;">
            <a href="index.html" style="color:#E0A21B;">بوابة المتقدمين</a>
            <span>|</span>
            <a href="Login.dc.html" style="color:#FFF;">🔒 بوابة اللجنة المحمية</a>
          </div>
        </div>
      </footer>
    `;
  }

  function renderAdminSidebar(activePage = 'dashboard') {
    let sidebarEl = document.getElementById('admin-sidebar-mount');
    if (!sidebarEl) return;

    const links = [
      { key: 'dashboard', href: 'Dashboard.dc.html', icon: '📊', label: 'نظرة عامة (Dashboard)', section: 'العمليات والفرز', roles: ['super_admin', 'committee_member', 'hr_coordinator'] },
      { key: 'jobbuilder', href: 'JobBuilder.dc.html', icon: '🎨', label: 'إعداد الوظائف وبرومنت AI', roles: ['super_admin', 'hr_coordinator'] },
      { key: 'profile', href: 'CandidateProfile.dc.html', icon: '👤', label: 'ملف المرشح وتقييم اللجنة', roles: ['super_admin', 'committee_member', 'hr_coordinator'] },
      { key: 'ranking', href: 'Ranking.dc.html', icon: '🏆', label: 'الترتيب الموزون (40/60)', roles: ['super_admin', 'committee_member', 'hr_coordinator'] },
      { key: 'scheduler', href: 'Scheduler.dc.html', icon: '📅', label: 'جدولة المقابلات الذكية', section: 'المقابلات والتواصل', roles: ['super_admin', 'hr_coordinator', 'committee_member'] },
      { key: 'reception', href: 'Reception.dc.html', icon: '🚪', label: 'استقبال المرشحين (QR)', roles: ['super_admin', 'hr_coordinator'] },
      { key: 'interviews', href: 'Interviews.dc.html', icon: '💬', label: 'طابور رسائل واتساب الهجين', roles: ['super_admin', 'hr_coordinator', 'committee_member'] },
      { key: 'aiengine', href: 'AIEngine.dc.html', icon: '🧠', label: 'محرك التحليل والفحص الأعمى', section: 'الحوكمة والتقنية', roles: ['super_admin', 'committee_member', 'hr_coordinator'] },
      { key: 'settings', href: 'Settings.dc.html', icon: '⚙️', label: 'الإعدادات وموديلات Ollama', roles: ['super_admin'] },
      { key: 'users', href: 'Users.dc.html', icon: '🛡️', label: 'حسابات اللجنة والصلاحيات', roles: ['super_admin'] },
      { key: 'system', href: 'System.dc.html', icon: '🗄️', label: 'معمارية النظام وقاعدة البيانات', roles: ['super_admin', 'committee_member', 'hr_coordinator'] }
    ];

    const aside = document.createElement('aside');
    aside.className = 'admin-sidebar';
    aside.id = 'admin-sidebar-active';
    sidebarEl.replaceWith(aside);

    const draw = (role = 'committee_member', user = null) => {
      let menuHtml = '';
      for (const item of links) {
        if (!item.roles.includes(role)) continue;
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

      aside.innerHTML = `
        <a href="Dashboard.dc.html" class="sidebar-brand">
          <div class="brand-swatch">ر</div>
          <div>
            <div style="font-family:var(--font-heading);font-weight:700;font-size:15px;color:#FFF;">لجنة التوظيف المركزية</div>
            <div class="mono" style="font-size:11px;color:#E0A21B;">RBAC + Ollama v2.1</div>
          </div>
        </a>

        <div style="margin:0 14px 10px;padding:10px 12px;background:rgba(255,255,255,0.06);border-radius:10px;border-right:3px solid #E0A21B;">
          <div style="font-size:13px;font-weight:700;color:#FFF;">${escapeHtml(user ? user.full_name : 'جاري التحقق...')}</div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
            <span class="mono" style="font-size:11px;color:#B8BCC4;">${escapeHtml(user ? '@' + user.username : '')}</span>
            <span style="font-size:10.5px;background:rgba(200,85,61,0.35);color:#FFD6CC;padding:2px 8px;border-radius:99px;">${escapeHtml(user ? user.role_label : '')}</span>
          </div>
        </div>

        <nav class="sidebar-menu" aria-label="قائمة لوحة التحكم">
          ${menuHtml}
        </nav>

        <div class="sidebar-footer" style="display:flex;flex-direction:column;gap:8px;">
          <a href="index.html" class="btn btn-outline btn-sm" style="background:transparent;color:#FFF;border-color:rgba(255,255,255,0.22);width:100%;">
            ↗ معاينة بوابة المتقدمين
          </a>
          <button type="button" onclick="SmartHR.logout()" class="btn btn-terracotta btn-sm" style="width:100%;">
            تسجيل الخروج الآمن 🚪
          </button>
        </div>
      `;
    };

    draw();

    getCurrentUser()
      .then((user) => {
        if (user) {
          draw(user.role, user);
          window.dispatchEvent(new CustomEvent('smarthr:user-ready', { detail: user }));
          if (['dashboard', 'scheduler', 'profile', 'ranking'].includes(activePage)) {
            startLobbyArrivalPolling();
          }
        }
      })
      .catch(() => {
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.replace(`Login.dc.html?next=${next}`);
      });
  }

  let _arrivalTimer = null;
  async function refreshLobbyArrivalBanner() {
    const mainEl = document.querySelector('.admin-main');
    if (!mainEl) return;
    try {
      const r = await fetch('/api/reception/arrivals');
      if (!r.ok) return;
      const data = await r.json();
      const waiting = data.waiting_candidates || [];
      let bar = document.getElementById('committee-arrival-alert-bar');
      if (!waiting.length) {
        if (bar) bar.remove();
        return;
      }
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'committee-arrival-alert-bar';
        bar.style.cssText = 'background:#1F3B34;color:#FFF;border-radius:14px;padding:12px 18px;margin-bottom:18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;border-right:5px solid #E0A21B;box-shadow:0 6px 18px rgba(31,59,52,0.18);';
        mainEl.prepend(bar);
      }
      const latest = waiting[0];
      const extraCnt = waiting.length > 1 ? ` (+${waiting.length - 1} آخرين في الانتظار)` : '';
      bar.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span style="font-size:20px;">🔔</span>
          <div>
            <div style="font-weight:700;font-size:14px;">
              وصل الآن في الاستقبال: <span style="color:#E0A21B;">${escapeHtml(latest.full_name)}</span>${escapeHtml(extraCnt)}
            </div>
            <div style="font-size:12px;color:#D6E2DF;">
              الوظيفة: ${escapeHtml(latest.job_title)} (${escapeHtml(latest.job_code)}) • القاعة/المكتب: ${escapeHtml(latest.office || 'المقر الرئيسي')}
            </div>
          </div>
          ${punctualityBadge(latest.punctuality_minutes)}
        </div>
        <a href="CandidateProfile.dc.html?app_id=${encodeURIComponent(latest.application_id)}" class="btn btn-saffron btn-sm" style="font-weight:700;">
          فتح ملف المرشح واستقباله ←
        </a>
      `;
    } catch (_e) {}
  }

  function startLobbyArrivalPolling() {
    refreshLobbyArrivalBanner();
    if (_arrivalTimer) clearInterval(_arrivalTimer);
    _arrivalTimer = setInterval(refreshLobbyArrivalBanner, 15000);
  }

  let _currentUserPromise = null;
  function getCurrentUser() {
    if (window.__CURRENT_USER) return Promise.resolve(window.__CURRENT_USER);
    if (!_currentUserPromise) {
      _currentUserPromise = fetch('/api/auth/me')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('AUTH_REQUIRED'))))
        .then((res) => {
          if (res && res.user) {
            window.__CURRENT_USER = res.user;
            return res.user;
          }
          throw new Error('AUTH_REQUIRED');
        });
    }
    return _currentUserPromise;
  }

  return {
    escapeHtml,
    deptColor,
    statusBadge,
    bookingBadge,
    punctualityBadge,
    formatDate,
    formatTime,
    showToast,
    apiFetch,
    getCurrentUser,
    refreshLobbyArrivalBanner,
    renderCandidateVerifyCard,
    logout,
    renderPortalHeader,
    renderPortalFooter,
    renderAdminSidebar
  };
})();
