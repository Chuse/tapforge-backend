Pages.chains = async function () {
  const page = document.getElementById('page')

  page.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Blockchains</h1>
        <div class="page-subtitle">Gestiona las redes soportadas por Desna</div>
      </div>

      <button class="primary-btn" onclick="Pages.openChainModal()">
        + Nueva blockchain
      </button>
    </div>

    <div class="card">
      <div id="chainsContent" class="empty">Cargando blockchains...</div>
    </div>
  `

  await Pages.loadChains()
}

Pages.loadChains = async function () {
  const container = document.getElementById('chainsContent')

  try {
    const data = await Api.get('/admin/chains')

    if (!data.chains || data.chains.length === 0) {
      container.innerHTML = `<div class="empty">No hay blockchains configuradas.</div>`
      return
    }

    container.innerHTML = `
      <table class="table">
        <thead>
          <tr>
            <th>Orden</th>
            <th>Nombre</th>
            <th>Símbolo</th>
            <th>Estado</th>
            <th>RPC</th>
            <th>Explorer</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${data.chains.map(chain => `
            <tr>
              <td>${chain.position ?? ''}</td>
              <td>
                <strong>${chain.display_name || chain.name}</strong>
                <div style="color:var(--muted);font-size:12px">${chain.id}</div>
              </td>
              <td>${chain.symbol}</td>
              <td>
                <span class="badge ${chain.enabled ? 'badge-on' : 'badge-off'}">
                  ${chain.enabled ? 'Activa' : 'Inactiva'}
                </span>
              </td>
              <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                ${chain.rpc || '-'}
              </td>
              <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                ${chain.explorer || '-'}
              </td>
              <td>
                <button class="secondary-btn" onclick='Pages.openChainModal(${JSON.stringify(chain)})'>
                  Editar
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `
  } catch (e) {
    container.innerHTML = `
      <div class="empty">
        Error cargando blockchains: ${e.message}
      </div>
    `
  }
}

Pages.openChainModal = function (chain = null) {
  const isEdit = !!chain

  const html = `
    <div class="modal-backdrop" id="chainModal">
      <div class="modal">
        <div class="modal-header">
          <h2>${isEdit ? 'Editar blockchain' : 'Nueva blockchain'}</h2>
          <button class="secondary-btn" onclick="Pages.closeChainModal()">Cerrar</button>
        </div>

        <div class="form-grid">
          <div class="field">
            <label>ID</label>
            <input id="chainId" value="${chain?.id || ''}" ${isEdit ? 'disabled' : ''}>
          </div>

          <div class="field">
            <label>Nombre interno</label>
            <input id="chainName" value="${chain?.name || ''}">
          </div>

          <div class="field">
            <label>Nombre visible</label>
            <input id="chainDisplayName" value="${chain?.display_name || ''}">
          </div>

          <div class="field">
            <label>Símbolo</label>
            <input id="chainSymbol" value="${chain?.symbol || ''}">
          </div>

          <div class="field">
            <label>Posición</label>
            <input id="chainPosition" type="number" value="${chain?.position ?? 99}">
          </div>

          <div class="field">
            <label>Logo URL</label>
            <input id="chainLogo" value="${chain?.logo || ''}">
          </div>

          <div class="field full">
            <label>RPC</label>
            <input id="chainRpc" value="${chain?.rpc || ''}">
          </div>

          <div class="field full">
            <label>Explorer</label>
            <input id="chainExplorer" value="${chain?.explorer || ''}">
          </div>

          <div class="field full checkbox-row">
            <label>
              <input id="chainEnabled" type="checkbox" ${chain?.enabled ? 'checked' : ''}>
              Blockchain activa
            </label>
          </div>
        </div>

        <div id="chainModalError" class="error"></div>

        <div class="modal-actions">
          <button class="secondary-btn" onclick="Pages.closeChainModal()">Cancelar</button>
          <button class="primary-btn" onclick="Pages.saveChain(${isEdit})">
            Guardar
          </button>
        </div>
      </div>
    </div>
  `

  document.body.insertAdjacentHTML('beforeend', html)
}

Pages.closeChainModal = function () {
  document.getElementById('chainModal')?.remove()
}

Pages.saveChain = async function (isEdit) {
  const error = document.getElementById('chainModalError')

  const id = document.getElementById('chainId').value.trim().toLowerCase()

  const payload = {
    id,
    name: document.getElementById('chainName').value.trim(),
    display_name: document.getElementById('chainDisplayName').value.trim(),
    symbol: document.getElementById('chainSymbol').value.trim().toUpperCase(),
    position: Number(document.getElementById('chainPosition').value || 99),
    logo: document.getElementById('chainLogo').value.trim() || null,
    rpc: document.getElementById('chainRpc').value.trim() || null,
    explorer: document.getElementById('chainExplorer').value.trim() || null,
    enabled: document.getElementById('chainEnabled').checked,
  }

  try {
    if (isEdit) {
      await Api.patch(`/admin/chains/${id}`, payload)
    } else {
      await Api.post('/admin/chains', payload)
    }

    Pages.closeChainModal()
    await Pages.loadChains()
  } catch (e) {
    error.innerText = e.message
  }
}
