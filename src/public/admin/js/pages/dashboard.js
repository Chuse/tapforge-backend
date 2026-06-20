Pages.dashboard = function () {
  const page = document.getElementById('page')

  page.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Dashboard</h1>
        <div class="page-subtitle">Panel de administración de Desna</div>
      </div>
    </div>

    <div class="card">
      <h3>Estado</h3>
      <p>La administración está inicializada correctamente.</p>
      <button class="primary-btn" onclick="Router.go('chains')">
        Gestionar blockchains
      </button>
    </div>
  `
}
