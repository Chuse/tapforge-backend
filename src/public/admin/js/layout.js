const Layout = {
  render(activePage) {
    return `
      <div class="admin-shell">
        <aside class="sidebar">
          <div class="brand">
            <div class="brand-logo">D</div>
            <div>
              <div class="brand-title">Desna Admin</div>
              <div class="brand-subtitle">Control panel</div>
            </div>
          </div>

          <nav class="nav">
            ${Layout.navItem('dashboard', 'Dashboard', activePage)}
            ${Layout.navItem('chains', 'Blockchains', activePage)}
            ${Layout.navItem('tokens', 'Tokens', activePage)}
            ${Layout.navItem('users', 'Usuarios', activePage)}
            ${Layout.navItem('logs', 'Logs', activePage)}
          </nav>

          <div class="sidebar-footer">
            <div class="user-box">
              <div class="user-name">${Auth.user?.name || 'Admin'}</div>
              <div class="user-role">${Auth.user?.role || ''}</div>
            </div>
            <button class="ghost-btn" onclick="Auth.logout()">Salir</button>
          </div>
        </aside>

        <main class="main">
          <div id="page"></div>
        </main>
      </div>
    `
  },

  navItem(page, label, activePage) {
    const active = page === activePage ? 'active' : ''
    return `
      <button class="nav-item ${active}" onclick="Router.go('${page}')">
        ${label}
      </button>
    `
  },
}
