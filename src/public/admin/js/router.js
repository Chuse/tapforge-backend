const Router = {
  current: 'dashboard',

  go(page) {
    Router.current = page
    location.hash = page
    Router.render()
  },

  async start() {
    const user = await Auth.loadMe()

    if (!user) {
      Router.current = 'login'
    } else {
      Router.current = location.hash.replace('#', '') || 'dashboard'
    }

    Router.render()
  },

  render() {
    const app = document.getElementById('app')

    if (Router.current === 'login') {
      app.innerHTML = Pages.login()
      Pages.bindLogin()
      return
    }

    if (!Auth.isLoggedIn()) {
      Router.go('login')
      return
    }

    app.innerHTML = Layout.render(Router.current)

    if (Router.current === 'dashboard') Pages.dashboard()
    if (Router.current === 'chains') Pages.chains()
    if (Router.current === 'tokens') Pages.tokens()
    if (Router.current === 'users') Pages.users()
    if (Router.current === 'logs') Pages.logs()
  },
}

window.addEventListener('hashchange', () => {
  const next = location.hash.replace('#', '') || 'dashboard'
  Router.current = next
  Router.render()
})
