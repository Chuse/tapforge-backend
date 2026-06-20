const Api = {
  token() {
    return localStorage.getItem(DESNA_ADMIN_CONFIG.tokenKey)
  },

  async request(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    }

    const token = Api.token()
    if (token) headers.Authorization = `Bearer ${token}`

    const res = await fetch(path, {
      ...options,
      headers,
    })

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      throw new Error(data.error || 'Error de servidor')
    }

    return data
  },

  get(path) {
    return Api.request(path)
  },

  post(path, body) {
    return Api.request(path, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },

  patch(path, body) {
    return Api.request(path, {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
  },

  delete(path) {
    return Api.request(path, {
      method: 'DELETE',
    })
  },
}
