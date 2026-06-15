// ─────────────────────────────────────────────────────────────────────────────
// Shared top navigation — single source of truth for all pages.
//
// Usage in each page:
//   <nav id="to-nav"></nav>
//   <script src="nav.js"></script>
//
// The script auto-detects the current page from the filename, reads project_id
// (URL param → sessionStorage), and renders the same nav everywhere with the
// current page highlighted and project_id carried through every link.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  const ITEMS = [
    { file: 'projects.html',     label: '⚡ Projects' },
    { file: 'discover.html',     label: '🔍 Discover' },
    { file: 'multi-page.html',   label: 'Take-off' },
    { file: 'device-types.html', label: '⚙ Device Types' },
  ];

  // Current page = last path segment; site root resolves to the Projects page.
  function currentFile() {
    const seg = (location.pathname.split('/').pop() || '').toLowerCase();
    return seg === '' ? 'projects.html' : seg;
  }

  // project_id: URL param wins, else sessionStorage (the convention used app-wide).
  function projectId() {
    const fromUrl = new URLSearchParams(location.search).get('project_id');
    if (fromUrl) return fromUrl;
    try { return sessionStorage.getItem('to_project_id') || null; } catch { return null; }
  }

  function render() {
    const mount = document.getElementById('to-nav');
    if (!mount) return;
    const cur = currentFile();
    const pid = projectId();
    const q   = pid ? `?project_id=${encodeURIComponent(pid)}` : '';

    const links = ITEMS.map((it) => {
      const active = it.file === cur;
      if (active) {
        return `<span class="to-nav-active">${it.label}</span>`;
      }
      return `<a class="to-nav-link" href="${it.file}${q}">${it.label}</a>`;
    }).join('<span class="to-nav-sep">·</span>');

    mount.innerHTML = links +
      '<span class="to-nav-spacer"></span>' +
      '<a class="to-nav-link" id="to-signout" href="#">⎋ Sign out</a>';

    const so = document.getElementById('to-signout');
    if (so) so.onclick = (e) => {
      e.preventDefault();
      if (window.TakeoffAuth) window.TakeoffAuth.signOut();
      else location.replace('login.html');
    };
  }

  // Minimal styling, injected once, matching the existing dark monospace theme.
  function injectStyle() {
    if (document.getElementById('to-nav-style')) return;
    const css = `
      #to-nav { font-family: monospace; font-size: 13px; margin: 6px 0 18px; display: flex;
                flex-wrap: wrap; align-items: center; gap: 4px; }
      #to-nav .to-nav-link { color: #7ac0f0; text-decoration: none; padding: 3px 10px;
                border: 1px solid #2a3a4a; border-radius: 3px; background: #0f1822; }
      #to-nav .to-nav-link:hover { background: #16242f; border-color: #3a6a8a; }
      #to-nav .to-nav-active { color: #7af07a; padding: 3px 10px; border: 1px solid #3a7a3a;
                border-radius: 3px; background: #14241a; font-weight: bold; }
      #to-nav .to-nav-sep { color: #444; padding: 0 2px; }
      #to-nav .to-nav-spacer { flex: 1 1 auto; }
    `;
    const el = document.createElement('style');
    el.id = 'to-nav-style';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function init() { injectStyle(); render(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for pages that set project_id late (after a project loads) and want to refresh.
  window.refreshNav = render;
})();
