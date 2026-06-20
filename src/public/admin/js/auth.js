const Auth = {
  user: null,

  async login(email, password) {
    const data = await Api.post('/admin/auth/login', { email, password })
    localStorage.setItem(DESNA_ADMIN_CONFIG.tokenKey, data.token)
    Auth.user = data.user
    return data.user
  },

  async logout() {
    try {
      await Api.post('/admin/auth/logout', {})
    } catch (_) {}

    localStorage.removeItem(DESNA_ADMIN_CONFIG.tokenKey)
    Auth.user = null
    Router.go('login')
  },

  async loadMe() {
    const token = localStorage.getItem(DESNA_ADMIN_CONFIG.tokenKey)
    if (!token) return null

    try {
      const data = await Api.get('/admin/auth/me')
      Auth.user = data.user
      return data.user
    } catch (_) {
      localStorage.removeItem(DESNA_ADMIN_CONFIG.tokenKey)
      Auth.user = null
      return null
    }
  },

  isLoggedIn() {
    return !!localStorage.getItem(DESNA_ADMIN_CONFIG.tokenKey)
  },
}
