Pages.login = function () {
  return `
    <div class="login-wrap">
      <div class="login-card">
        <h1 class="login-title">Desna Admin</h1>
        <p class="login-subtitle">Acceso privado de administración</p>

        <div class="field">
          <label>Email</label>
          <input id="loginEmail" type="email" autocomplete="email">
        </div>

        <div class="field">
          <label>Contraseña</label>
          <input id="loginPassword" type="password" autocomplete="current-password">
        </div>

        <button class="primary-btn" id="loginButton" style="width:100%">
          Entrar
        </button>

        <div id="loginError" class="error"></div>
      </div>
    </div>
  `
}

Pages.bindLogin = function () {
  document.getElementById('loginButton').onclick = async () => {
    const error = document.getElementById('loginError')
    error.innerText = ''

    try {
      await Auth.login(
        document.getElementById('loginEmail').value,
        document.getElementById('loginPassword').value
      )
      Router.go('dashboard')
    } catch (e) {
      error.innerText = e.message
    }
  }
}
