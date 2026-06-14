/**
 * reportService.js
 * Genera el texto del informe de época para el canal privado de Telegram
 * Usa parse_mode: 'HTML' — mucho más robusto que MarkdownV2
 */

// ─── Helpers de formato ───────────────────────────────────────────────────────

function fmt(n, decimals = 2) {
  return n.toLocaleString('en-US', { maximumFractionDigits: decimals })
}

function fmtKlv(n) {
  if (n >= 1_000_000_000) return `${fmt(n / 1_000_000_000, 2)}B KLV`
  if (n >= 1_000_000)     return `${fmt(n / 1_000_000,     2)}M KLV`
  if (n >= 1_000)         return `${fmt(n / 1_000,         2)}K KLV`
  return `${fmt(n, 2)} KLV`
}

function diffKlv(current, previous) {
  if (previous === undefined || previous === null) return ''
  const delta = current - previous
  const sign  = delta >= 0 ? '▲' : '▼'
  return ` ${sign} ${fmtKlv(Math.abs(delta))}`
}

function diffPct(current, previous) {
  if (!previous) return ''
  const pct  = ((current - previous) / previous) * 100
  const sign = pct >= 0 ? '▲' : '▼'
  return ` ${sign} ${Math.abs(pct).toFixed(2)}%`
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function b(text)  { return `<b>${escapeHtml(text)}</b>` }
function i(text)  { return `<i>${escapeHtml(text)}</i>` }
function code(text) { return `<code>${escapeHtml(text)}</code>` }

// ─── Election changes ─────────────────────────────────────────────────────────

function buildElectionChanges(current, previous) {
  if (!previous) return `<i>Sin datos de época anterior para comparar</i>\n`

  const prevElected = new Set(
    previous.validatorList.filter(v => v.elected).map(v => v.address)
  )
  const currElected = new Set(
    current.validatorList.filter(v => v.elected).map(v => v.address)
  )

  const entered = current.validatorList.filter(v => v.elected && !prevElected.has(v.address))
  const exited  = previous.validatorList.filter(v => v.elected && !currElected.has(v.address))

  if (entered.length === 0 && exited.length === 0) {
    return `<i>Sin cambios en la elección</i>\n`
  }

  let text = ''
  if (entered.length > 0) {
    text += `✅ <b>Nuevos elegidos:</b>\n`
    for (const v of entered) {
      const name = escapeHtml(v.name || `${v.address.slice(0, 8)}...`)
      text += `  • ${name}\n`
    }
  }
  if (exited.length > 0) {
    text += `❌ <b>Salieron:</b>\n`
    for (const v of exited) {
      const name = escapeHtml(v.name || `${v.address.slice(0, 8)}...`)
      text += `  • ${name}\n`
    }
  }

  return text
}

// ─── Informe completo ─────────────────────────────────────────────────────────

function buildEpochReport(current, previous) {
  const dateStr = current.timestampEnd.toUTCString().replace(' GMT', ' UTC')
  const lines   = []

  // Cabecera
  lines.push(`🔷 <b>INFORME ÉPOCA ${current.epochNumber}</b>`)
  lines.push(`📅 ${escapeHtml(dateStr)}`)
  lines.push('')

  // Precio KLV
  lines.push('💰 <b>PRECIO KLV</b>')
  const priceStr  = `$${current.klvPriceUsdt.toFixed(6)}`
  const priceDiff = diffPct(current.klvPriceUsdt, previous?.klvPriceUsdt)
  const change24  = current.klvPriceChange24h >= 0
    ? `▲ ${current.klvPriceChange24h.toFixed(2)}%`
    : `▼ ${Math.abs(current.klvPriceChange24h).toFixed(2)}%`
  lines.push(`  ${escapeHtml(priceStr)}${escapeHtml(priceDiff)} | 24h: ${escapeHtml(change24)}`)
  lines.push('')

  // Stats de red
  lines.push('📊 <b>STATS DE RED</b>')
  const stakingDiff = diffKlv(current.stakingTotal, previous?.stakingTotal)
  lines.push(`  Staking total:  ${escapeHtml(fmtKlv(current.stakingTotal))}${escapeHtml(stakingDiff)}`)

  if (current.circulatingSupply > 0) {
    const pctStaked = (current.stakingTotal / current.circulatingSupply) * 100
    lines.push(`  % del supply:   ${escapeHtml(pctStaked.toFixed(2))}%`)
  }

  const burnedDiff = diffKlv(current.burned, previous?.burned)
  lines.push(`  KLV quemados:   ${escapeHtml(fmtKlv(current.burned))}${escapeHtml(burnedDiff)}`)
  lines.push(`  Circulación:    ${escapeHtml(fmtKlv(current.circulatingSupply))}`)
  lines.push('')

  // Actividad on-chain
  lines.push('⚡ <b>ACTIVIDAD ON-CHAIN</b>')
  const txDiff  = previous
    ? ` (${current.txCount >= previous.txCount ? '+' : ''}${current.txCount - (previous?.txCount ?? 0)})`
    : ''
  const dauDiff = previous
    ? ` (${current.dau >= previous.dau ? '+' : ''}${current.dau - (previous?.dau ?? 0)})`
    : ''
  lines.push(`  Transacciones:   ${escapeHtml(fmt(current.txCount, 0))}${escapeHtml(txDiff)}`)
  lines.push(`  Wallets activas: ${escapeHtml(fmt(current.dau, 0))}${escapeHtml(dauDiff)}`)
  lines.push('')

  // Top tipos de tx
  if (current.topContracts.length > 0) {
    lines.push('🔀 <b>TOP TIPOS DE TX</b>')
    for (let i = 0; i < Math.min(5, current.topContracts.length); i++) {
      const { type, count } = current.topContracts[i]
      lines.push(`  ${i + 1}. ${escapeHtml(type)}: ${escapeHtml(fmt(count, 0))}`)
    }
    lines.push('')
  }

  // Top KDAs
  if (current.topKdas.length > 0) {
    lines.push('🏆 <b>TOP 3 KDA POR ACTIVIDAD</b>')
    for (let i = 0; i < Math.min(3, current.topKdas.length); i++) {
      const { asset, count } = current.topKdas[i]
      lines.push(`  ${i + 1}. ${escapeHtml(asset)}: ${escapeHtml(fmt(count, 0))} txs`)
    }
    lines.push('')
  }

  // Validadores
  lines.push('🛡️ <b>ESTADO DE VALIDADORES</b>')
  lines.push(`  Total:     ${current.validatorsTotal}`)
  lines.push(`  Elegidos:  ${current.validatorsElected}`)
  lines.push(`  En jail:   ${current.validatorsJailed}`)
  lines.push(`  Inactivos: ${current.validatorsInactive}`)
  lines.push(`  En espera: ${current.validatorsWaiting}`)
  lines.push('')

  // Election changes
  lines.push('🗳️ <b>CAMBIOS EN ELECCIÓN</b>')
  lines.push(buildElectionChanges(current, previous))

  // Pie
  lines.push('─────────────────────')
  lines.push('<i>Desna · Klever Network Intelligence</i>')

  return lines.join('\n')
}

// ─── Resumen público ──────────────────────────────────────────────────────────

function buildPublicSummary(current) {
  const lines = []
  lines.push(`🔷 <b>Época ${current.epochNumber} cerrada</b>`)
  lines.push(`💰 KLV: $${current.klvPriceUsdt.toFixed(6)}`)
  lines.push(`⚡ ${fmt(current.txCount, 0)} txs | ${fmt(current.dau, 0)} wallets activas`)
  lines.push(`🛡️ ${current.validatorsElected} validadores elegidos`)
  lines.push('')
  lines.push('<i>Informe completo disponible en el canal premium 👆</i>')
  return lines.join('\n')
}

module.exports = { buildEpochReport, buildPublicSummary }
