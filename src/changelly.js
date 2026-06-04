const crypto = require('crypto')

const CHANGELLY_URL = 'https://api.changelly.com/v2'

// Construye la private key desde hex (variable de entorno)
function getPrivateKey() {
  const hex = process.env.CHANGELLY_PRIVATE_KEY
  if (!hex) throw new Error('CHANGELLY_PRIVATE_KEY no configurada')
  return crypto.createPrivateKey({
    key: hex,
    format: 'der',
    type: 'pkcs8',
    encoding: 'hex',
  })
}

// Firma el body y devuelve los headers de autenticación
function buildHeaders(body) {
  const privateKey = getPrivateKey()
  const publicKey  = crypto.createPublicKey(privateKey).export({ type: 'pkcs1', format: 'der' })
  const apiKey     = crypto.createHash('sha256').update(publicKey).digest('base64')
  const signature  = crypto.sign('sha256', Buffer.from(JSON.stringify(body)), {
    key: privateKey, type: 'pkcs8', format: 'der',
  })
  return {
    'Content-Type':    'application/json',
    'X-Api-Key':       apiKey,
    'X-Api-Signature': signature.toString('base64'),
  }
}

// Llamada genérica a Changelly
async function changellyCall(method, params = {}) {
  const body = {
    jsonrpc: '2.0',
    id:      crypto.randomUUID(),
    method,
    params,
  }
  const res  = await fetch(CHANGELLY_URL, {
    method:  'POST',
    headers: buildHeaders(body),
    body:    JSON.stringify(body),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error.message ?? JSON.stringify(data.error))
  return data.result
}

module.exports = { changellyCall }
