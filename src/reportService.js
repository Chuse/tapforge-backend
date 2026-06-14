/**
 * reportService.js
 * Genera el texto del informe de época para el canal privado de Telegram
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

function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\-]/g, '\\$&')
}

// ─── Election changes ─────────────────────────────────────────────────────────

function buildElectionChanges(current, previous) {
  if (!previous) return '_Sin datos de época anterior para comparar_\n'

  const prevElected = new Set(
    previous.validatorList.filter(v => v.elected).map(v => v.address)
  )
  const currElected = new Set(
    current.validatorList.filter(v => v.elected).map(v => v.address)
  )

  const entered = current.validatorList.filter(v => v.elected && !prevElected.has(v.address))
  const exited  = previous.validatorList.filter(v => v.elected && !currElected.has(v.address))

  if (entered.length === 0 && exited.length === 0) {
    return '_Sin cambios en la elección_\n'
  }

  let text = ''
  if (entered.length > 0) {
    text += `✅ *Nuevos elegidos:*\n`
    for (const v of entered) {
      const name = escapeMarkdown(v.name || `${v.address.slice(0, 8)}...`)
      text += `  • ${name}\n`
    }
  }
  if (exited.length > 0) {
    text += `❌ *Salieron:*\n`
    for (const v of exited) {
      const name = escapeMarkdown(v.name || `${v.address.slice(0, 8)}...`)
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
  lines.push(`🔷 *INFORME ÉPOCA ${current.epochNumber}*`)
  lines.push(`📅 ${escapeMarkdown(dateStr)}`)
  lines.push('')

  // Precio KLV
  lines.push('💰 *PRECIO KLV*')
  const priceStr  = `$${current.klvPriceUsdt.toFixed(6)}`
  const priceDiff = diffPct(current.klvPriceUsdt, previous?.klvPriceUsdt)
  const change24  = current.klvPriceChange24h >= 0
    ? `▲ ${current.klvPriceChange24h.toFixed(2)}%`
    : `▼ ${Math.abs(current.klvPriceChange24h).toFixed(2)}%`
  lines.push(`  ${escapeMarkdown(priceStr)}${escapeMarkdown(priceDiff)} \\| 24h: ${escapeMarkdown(change24)}`)
  lines.push('')

  // Stats de red
  lines.push('📊 *STATS DE RED*')
  const stakingDiff = diffKlv(current.stakingTotal, previous?.stakingTotal)
  lines.push(`  Staking total:  ${escapeMarkdown(fmtKlv(current.stakingTotal))}${escapeMarkdown(stakingDiff)}`)

  if (current.circulatingSupply > 0) {
    const pctStaked = (current.stakingTotal / current.circulatingSupply) * 100
    lines.push(`  % del supply:   ${escapeMarkdown(pctStaked.toFixed(2))}%`)
  }

  const burnedDiff = diffKlv(current.burned, previous?.burned)
  lines.push(`  KLV quemados:   ${escapeMarkdown(fmtKlv(current.burned))}${escapeMarkdown(burnedDiff)}`)
  lines.push(`  Circulación:    ${escapeMarkdown(fmtKlv(current.circulatingSupply))}`)
  lines.push('')

  // Actividad on-chain
  lines.push('⚡ *ACTIVIDAD ON\\-CHAIN*')
  const txDiff  = previous ? ` \\(${current.txCount  >= previous.txCount  ? '+' : ''}${current.txCount  - (previous?.txCount  ?? 0)}\\)` : ''
  const dauDiff = previous ? ` \\(${current.dau      >= previous.dau      ? '+' : ''}${current.dau      - (previous?.dau      ?? 0)}\\)` : ''
  lines.push(`  Transacciones:   ${escapeMarkdown(fmt(current.txCount, 0))}${txDiff}`)
  lines.push(`  Wallets activas: ${escapeMarkdown(fmt(current.dau,     0))}${dauDiff}`)
  lines.push('')

  // Top tipos de tx
  if (current.topContracts.length > 0) {
    lines.push('🔀 *TOP TIPOS DE TX*')
    for (let i = 0; i < Math.min(5, current.topContracts.length); i++) {
      const { type, count } = current.topContracts[i]
      lines.push(`  ${i + 1}\\. ${escapeMarkdown(type)}: ${escapeMarkdown(fmt(count, 0))}`)
    }
    lines.push('')
  }

  // Top KDAs
  if (current.topKdas.length > 0) {
    lines.push('🏆 *TOP 3 KDA POR ACTIVIDAD*')
    for (let i = 0; i < Math.min(3, current.topKdas.length); i++) {
      const { asset, count } = current.topKdas[i]
      lines.push(`  ${i + 1}\\. ${escapeMarkdown(asset)}: ${escapeMarkdown(fmt(count, 0))} txs`)
    }
    lines.push('')
  }

  // Validadores
  lines.push('🛡️ *ESTADO DE VALIDADORES*')
  lines.push(`  Total:     ${current.validatorsTotal}`)
  lines.push(`  Elegidos:  ${current.validatorsElected}`)
  lines.push(`  En jail:   ${current.validatorsJailed}`)
  lines.push(`  Inactivos: ${current.validatorsInactive}`)
  lines.push(`  En espera: ${current.validatorsWaiting}`)
  lines.push('')

  // Election changes
  lines.push('🗳️ *CAMBIOS EN ELECCIÓN*')
  lines.push(buildElectionChanges(current, previous))

  // Pie
  lines.push('─────────────────────')
  lines.push('_Desna · Klever Network Intelligence_')

  return lines.join('\n')
}

// ─── Resumen público ──────────────────────────────────────────────────────────

function buildPublicSummary(current) {
  const lines = []
  lines.push(`🔷 *Época ${current.epochNumber} cerrada*`)
  lines.push(`💰 KLV: $${current.klvPriceUsdt.toFixed(6)}`)
  lines.push(`⚡ ${fmt(current.txCount, 0)} txs \\| ${fmt(current.dau, 0)} wallets activas`)
  lines.push(`🛡️ ${current.validatorsElected} validadores elegidos`)
  lines.push('')
  lines.push('_Informe completo disponible en el canal premium_ 👆')
  return lines.join('\n')
}

module.exports = { buildEpochReport, buildPublicSummary }
