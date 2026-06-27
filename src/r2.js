/**
 * r2.js
 * Mirror de logos de tokens a Cloudflare R2 (storage S3-compatible, egress gratis).
 *
 * Resuelve el problema de los logos externos rotos (404 de URLs de terceros):
 * descargamos cada logo una vez, lo subimos a NUESTRO bucket R2, y guardamos en
 * la columna `logo` la URL pública de R2 — estable y bajo nuestro control.
 *
 * Variables de entorno (las que YA tienes en tu .env / Railway):
 *   R2_ENDPOINT           → URL del endpoint S3 de R2 (https://xxxx.r2.cloudflarestorage.com)
 *   R2_ACCESS_KEY_ID      → del API token de R2
 *   R2_SECRET_ACCESS_KEY  → del API token de R2
 *   R2_BUCKET_NAME        → nombre del bucket
 *   R2_PUBLIC_BASE        → URL PÚBLICA del bucket, SIN barra final
 *                           (ej. 'https://pub-xxxx.r2.dev' o 'https://logos.desna.io')
 *                           OJO: es distinta de R2_ENDPOINT. El endpoint es para
 *                           ESCRIBIR (privado, API S3); la base pública es para que
 *                           el cliente LEA las imágenes. Requiere activar acceso
 *                           público en el bucket.
 *
 * Si FALTA cualquiera de ellas, isR2Configured() devuelve false y el sync sigue
 * funcionando con la URL externa como fallback (no rompe nada si aún no creaste
 * el bucket). Así puedes desplegar este código antes de configurar R2.
 *
 * Dependencia: @aws-sdk/client-s3  (npm i @aws-sdk/client-s3)
 */

const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3')

const {
  R2_ENDPOINT,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
  R2_PUBLIC_BASE,
} = process.env

let _client = null

function isR2Configured() {
  return Boolean(
    R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME && R2_PUBLIC_BASE
  )
}

function getClient() {
  if (_client) return _client
  if (!isR2Configured()) return null
  _client = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  })
  return _client
}

// Extensión a partir del content-type, para guardar la clave con extensión sensata.
function extFromContentType(ct) {
  if (!ct) return 'png'
  if (ct.includes('svg')) return 'svg'
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg'
  if (ct.includes('webp')) return 'webp'
  if (ct.includes('gif')) return 'gif'
  return 'png'
}

// Clave estable en el bucket: logos/{chainId}/{tokenId}.{ext}
// Sanitizamos tokenId para que sea una clave válida (mismo charset que PARAM_REGEX).
function buildKey(chainId, tokenId, ext) {
  const safeChain = String(chainId).replace(/[^a-zA-Z0-9_-]/g, '_')
  const safeToken = String(tokenId).replace(/[^a-zA-Z0-9_-]/g, '_')
  return `logos/${safeChain}/${safeToken}.${ext}`
}

function publicUrlForKey(key) {
  return `${R2_PUBLIC_BASE.replace(/\/$/, '')}/${key}`
}

/**
 * ¿Ya existe este objeto en el bucket? Evita re-descargar/re-subir en cada sync.
 * Devuelve la URL pública si existe, o null si no.
 */
async function existsInR2(chainId, tokenId) {
  const client = getClient()
  if (!client) return null
  // Probamos las extensiones más comunes (no sabemos cuál se usó sin listar).
  for (const ext of ['png', 'svg', 'jpg', 'webp', 'gif']) {
    const key = buildKey(chainId, tokenId, ext)
    try {
      await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }))
      return publicUrlForKey(key)
    } catch {
      // 404 → probar siguiente extensión
    }
  }
  return null
}

/**
 * Descarga el logo desde su URL externa y lo sube a R2.
 * Devuelve la URL pública de R2, o null si falla (logo externo caído, etc.).
 *
 * @param {string} chainId
 * @param {string} tokenId
 * @param {string} externalUrl  URL del logo en el origen (Klever, etc.)
 * @param {object} [opts]
 * @param {boolean} [opts.skipIfExists=true]  si ya está en R2, no re-sube
 */
async function mirrorLogo(chainId, tokenId, externalUrl, opts = {}) {
  const { skipIfExists = true } = opts
  const client = getClient()
  if (!client || !externalUrl) return null

  // Dedup: si ya lo tenemos, devolvemos la URL existente sin tocar la red.
  if (skipIfExists) {
    const existing = await existsInR2(chainId, tokenId)
    if (existing) return existing
  }

  try {
    const resp = await fetch(externalUrl)
    if (!resp.ok) return null  // origen 404/500 → no mirroreamos, cae a placeholder

    const contentType = resp.headers.get('content-type') || 'image/png'
    // Solo aceptamos imágenes (evita guardar páginas de error HTML como "logo")
    if (!contentType.startsWith('image/')) return null

    const arrayBuf = await resp.arrayBuffer()
    const body = Buffer.from(arrayBuf)

    // Límite de tamaño defensivo: un logo no debería pesar > 1 MB
    if (body.length === 0 || body.length > 1024 * 1024) return null

    const ext = extFromContentType(contentType)
    const key = buildKey(chainId, tokenId, ext)

    await client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable', // 1 año en CDN/cliente
    }))

    return publicUrlForKey(key)
  } catch (e) {
    console.warn(`[r2] mirror falló para ${chainId}/${tokenId}:`, e.message)
    return null
  }
}

module.exports = {
  isR2Configured,
  mirrorLogo,
  existsInR2,
  publicUrlForKey,
  buildKey,
}
