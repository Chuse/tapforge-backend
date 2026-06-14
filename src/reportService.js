/**
 * reportService.js
 * Genera los 3 mensajes del informe de época
 * parse_mode: HTML
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n, decimals = 2) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: decimals })
}

function fmtKlv(n) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B KLV`
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(2)}M KLV`
  if (n >= 1_000)         return `${(n / 1_000).toFixed(1)}K KLV`
  return `${n.toFixed(2)} KLV`
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function diffKlv(current, previous) {
  if (previous == null) return ''
  const delta = current - previous
  const sign  = delta >= 0 ? '▲' : '▼'
  return ` ${sign} ${fmtKlv(Math.abs(delta))}`
}

function diffNum(current, previous) {
  if (previous == null) return ''
  const delta = current - previous
  return ` (${delta >= 0 ? '+' : ''}${fmt(delta, 0)})`
}

function diffPct(current, previous) {
  if (!previous) return ''
  const pct  = ((current - previous) / previous) * 100
  const sign = pct >= 0 ? '▲' : '▼'
  return ` ${sign} ${Math.abs(pct).toFixed(2)}%`
}

function stakingBar(pct) {
  const filled = Math.round(pct / 10)
  const half   = (pct % 10) >= 5 ? 1 : 0
  const empty  = 10 - filled - half
  return '█'.repeat(filled) + (half ? '▓' : '') + '░'.repeat(empty)
}

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// ─── Mensaje 1 — Red y Precio ─────────────────────────────────────────────────

function buildMsg1(current, previous) {
  const dateStr     = current.timestampEnd.toUTCString().replace(' GMT', ' UTC')
  const pctStaked   = current.circulatingSupply > 0
    ? (current.stakingTotal / current.circulatingSupply) * 100 : 0
  const pctDelegated = current.stakingTotal > 0
    ? (current.networkTotalDelegated / current.stakingTotal) * 100 : 0

  const burnedEpoch = previous ? current.burned - previous.burned : null

  const lines = []

  lines.push(`🔷 <b>INFORME ÉPOCA ${current.epochNumber}</b>`)
  lines.push(`📅 ${escapeHtml(dateStr)}`)
  lines.push('')

  // Precio
  lines.push('💰 <b>PRECIO KLV</b>')
  const priceDiff = diffPct(current.klvPriceUsdt, previous?.klvPriceUsdt)
  const change24  = current.klvPriceChange24h >= 0
    ? `▲ ${current.klvPriceChange24h.toFixed(2)}%`
    : `▼ ${Math.abs(current.klvPriceChange24h).toFixed(2)}%`
  lines.push(`  $${current.klvPriceUsdt.toFixed(6)}${escapeHtml(priceDiff)} | 24h: ${escapeHtml(change24)}`)
  const mcap = (current.klvPriceUsdt * current.circulatingSupply).toFixed(0)
  lines.push(`  Market Cap: $${escapeHtml(fmt(Number(mcap), 0))}${escapeHtml(diffNum(Number(mcap), previous ? previous.klvPriceUsdt * previous.circulatingSupply : null))}`)
  lines.push('')

  // Stats de red
  lines.push('📊 <b>STATS DE RED</b>')
  lines.push(`  Staking total:  ${escapeHtml(fmtKlv(current.stakingTotal))}${escapeHtml(diffKlv(current.stakingTotal, previous?.stakingTotal))}`)
  lines.push(`  ${escapeHtml(stakingBar(pctStaked))} ${escapeHtml(pctStaked.toFixed(1))}% staked`)
  lines.push(`  Delegado:       ${escapeHtml(fmtKlv(current.networkTotalDelegated))}`)
  lines.push(`  ${escapeHtml(stakingBar(pctDelegated))} ${escapeHtml(pctDelegated.toFixed(1))}% delegado`)
  lines.push(`  Circulación:    ${escapeHtml(fmtKlv(current.circulatingSupply))}`)

  if (burnedEpoch !== null) {
    lines.push(`  KLV quemados época: ${escapeHtml(fmtKlv(burnedEpoch))}`)
  }
  lines.push(`  KLV quemados total: ${escapeHtml(fmtKlv(current.burned))}`)
  lines.push('')

  // Fees
  lines.push('⛽ <b>FEES DE LA ÉPOCA</b>')
  lines.push(`  kApp Fee:      ${escapeHtml(fmtKlv(current.totalKAppFee ?? 0))}`)
  lines.push(`  Bandwidth Fee: ${escapeHtml(fmtKlv(current.totalBwFee   ?? 0))}`)
  lines.push(`  Burned Fee:    ${escapeHtml(fmtKlv(current.burnedFee    ?? 0))}`)
  lines.push(`  Vol. KLV:      ${escapeHtml(fmtKlv(current.volumeKlv   ?? 0))}`)
  lines.push('')

  lines.push('─────────────────────')
  lines.push('<i>Desna · La wallet que te entiende</i>')

  return lines.join('\n')
}

// ─── Mensaje 2 — Actividad on-chain ───────────────────────────────────────────

function buildMsg2(current, previous) {
  const lines = []

  lines.push(`⚡ <b>ACTIVIDAD ON-CHAIN — Época ${current.epochNumber}</b>`)
  lines.push('')

  lines.push(`  Transacciones:   <b>${escapeHtml(fmt(current.txCount, 0))}</b>${escapeHtml(diffNum(current.txCount, previous?.txCount))}`)
  lines.push(`  Wallets activas: <b>${escapeHtml(fmt(current.dau, 0))}</b>${escapeHtml(diffNum(current.dau, previous?.dau))}`)

  if (current.mostActiveAddr) {
    lines.push(`  Más activa: <code>${escapeHtml(shortAddr(current.mostActiveAddr))}</code> (${current.mostActiveTxCount} txs)`)
  }
  lines.push('')

  // Top tipos de tx
  if (current.topContracts?.length > 0) {
    lines.push('🔀 <b>TOP TIPOS DE TX</b>')
    for (let i = 0; i < Math.min(5, current.topContracts.length); i++) {
      const { type, count } = current.topContracts[i]
      lines.push(`  ${i + 1}. ${escapeHtml(type)}: ${escapeHtml(fmt(count, 0))}`)
    }
    lines.push('')
  }

  // Top KDA por tipo
  const sections = [
    { label: 'Transfers',      data: current.topKdaTransfers },
    { label: 'Claims',         data: current.topKdaClaims    },
    { label: 'Freezes',        data: current.topKdaFreezes   },
  ]

  lines.push('🏆 <b>TOP KDA POR OPERACIÓN</b>')
  for (const { label, data } of sections) {
    if (!data?.length) continue
    lines.push(`  <i>${label}:</i>`)
    for (let i = 0; i < Math.min(3, data.length); i++) {
      const { asset, count } = data[i]
      lines.push(`    ${i + 1}. ${escapeHtml(asset)}: ${escapeHtml(fmt(count, 0))} txs`)
    }
  }
  lines.push('')

  // Top Smart Contracts
  if (current.topSmartContracts?.length > 0) {
    lines.push('🤖 <b>TOP SMART CONTRACTS</b>')
    for (let i = 0; i < Math.min(3, current.topSmartContracts.length); i++) {
      const { addr, count } = current.topSmartContracts[i]
      lines.push(`  ${i + 1}. <code>${escapeHtml(addr)}</code>: ${escapeHtml(fmt(count, 0))} txs`)
    }
    lines.push('')
  }

  lines.push('─────────────────────')
  lines.push('<i>Desna · La wallet que te entiende</i>')

  return lines.join('\n')
}

// ─── Mensaje 3 — Validadores ──────────────────────────────────────────────────

function buildMsg3(current, previous) {
  const lines = []

  lines.push(`🛡️ <b>VALIDADORES — Época ${current.epochNumber}</b>`)
  lines.push('')

  lines.push('📋 <b>ESTADO GENERAL</b>')
  lines.push(`  Total:     ${current.validatorsTotal}`)
  lines.push(`  Elegidos:  ${current.validatorsElected}`)
  lines.push(`  En jail:   ${current.validatorsJailed}`)
  lines.push(`  Inactivos: ${current.validatorsInactive}`)
  lines.push(`  En espera: ${current.validatorsWaiting}`)
  lines.push('')

  // Election changes
  lines.push('🗳️ <b>CAMBIOS EN ELECCIÓN</b>')
  lines.push(buildElectionChanges(current, previous))

  // Validator Spotlight
  if (current.spotlight) {
    const s       = current.spotlight
    const total   = s.totalSuccess + s.totalFailure
    const ratePct = s.successRate.toFixed(3)
    lines.push('⭐ <b>VALIDATOR SPOTLIGHT</b>')
    lines.push(`  <b>${escapeHtml(s.name || shortAddr(s.address))}</b>`)
    lines.push(`  Success rate: ${escapeHtml(ratePct)}% (${escapeHtml(fmt(total, 0))} bloques históricos)`)
    lines.push(`  Stake total:  ${escapeHtml(fmtKlv(s.stake))}`)
    lines.push(`  Comisión:     ${(s.commission / 100).toFixed(2)}%`)
    lines.push('')
  }

  lines.push('─────────────────────')
  lines.push('<i>Desna · La wallet que te entiende</i>')

  return lines.join('\n')
}

// ─── Election changes ─────────────────────────────────────────────────────────

function buildElectionChanges(current, previous) {
  if (!previous) return '<i>Sin datos de época anterior para comparar</i>\n'

  const prevElected = new Set(
    previous.validatorList.filter(v => v.elected).map(v => v.address)
  )
  const currElected = new Set(
    current.validatorList.filter(v => v.elected).map(v => v.address)
  )

  const entered = current.validatorList.filter(v => v.elected && !prevElected.has(v.address))
  const exited  = previous.validatorList.filter(v => v.elected && !currElected.has(v.address))

  if (entered.length === 0 && exited.length === 0) {
    return '<i>Sin cambios en la elección</i>\n'
  }

  let text = ''
  if (entered.length > 0) {
    text += `✅ <b>Nuevos elegidos:</b>\n`
    for (const v of entered) {
      text += `  • ${escapeHtml(v.name || shortAddr(v.address))}\n`
    }
  }
  if (exited.length > 0) {
    text += `❌ <b>Salieron:</b>\n`
    for (const v of exited) {
      text += `  • ${escapeHtml(v.name || shortAddr(v.address))}\n`
    }
  }
  return text
}

// ─── Exportar los 3 mensajes ──────────────────────────────────────────────────

function buildEpochMessages(current, previous) {
  return [
    buildMsg1(current, previous),
    buildMsg2(current, previous),
    buildMsg3(current, previous),
  ]
}

// Mantener compatibilidad con bot.js que llama buildEpochReport
function buildEpochReport(current, previous) {
  return buildMsg1(current, previous)
}

function buildPublicSummary(current) {
  const pctStaked = current.circulatingSupply > 0
    ? (current.stakingTotal / current.circulatingSupply) * 100 : 0
  const lines = []
  lines.push(`🔷 <b>Época ${current.epochNumber} cerrada</b>`)
  lines.push(`💰 KLV: $${current.klvPriceUsdt.toFixed(6)}`)
  lines.push(`⚡ ${fmt(current.txCount, 0)} txs | ${fmt(current.dau, 0)} wallets activas`)
  lines.push(`🛡️ ${current.validatorsElected} elegidos | ${escapeHtml(stakingBar(pctStaked))} ${pctStaked.toFixed(1)}% staked`)
  lines.push('')
  lines.push('<i>Informe completo disponible en el canal premium 👆</i>')
  return lines.join('\n')
}

module.exports = { buildEpochReport, buildEpochMessages, buildPublicSummary }
