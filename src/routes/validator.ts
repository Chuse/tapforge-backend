import { AccountSnapshot, Rule, Signal, ValidatorChange } from '../types'

// Escala de la comisión que devuelve el backend (valor crudo de la API de Klever).
// Confirmado: el máximo 100% llega como 10000 → escala ×100. Ej: 4000 = 40%, 500 = 5%.
const COMMISSION_DIVISOR = 100

// Delta mínimo de comisión (en PUNTOS porcentuales) para avisar. 0.5 = medio punto.
const MIN_COMMISSION_DELTA = 0.5

const pct = (raw: number) => raw / COMMISSION_DIVISOR
const round1 = (n: number) => Math.round(n * 10) / 10

function delegatesTo(s: AccountSnapshot, address: string): boolean {
  return s.delegations.some((d) => d.validatorAddress === address)
}

// Solo se avisa de cambios en validadores donde el usuario delega.
const validatorChanges: Rule = {
  id: 'validator-changes',
  evaluate(s: AccountSnapshot): Signal[] {
    const out: Signal[] = []

    for (const c of s.validatorChanges) {
      if (!delegatesTo(s, c.address)) continue
      const name = c.name || `${c.address.slice(0, 10)}...`

      // Jailed → rojo/gratis (proteges al usuario de seguir perdiendo recompensas).
      if (c.becameJailed) {
        out.push(jailedSignal(c, name))
        continue // jail manda; no duplicamos con deseleccionado
      }

      // Deseleccionado → rojo/gratis.
      if (c.becameDeselected) {
        out.push(deselectedSignal(c, name))
        continue
      }

      // Subida de comisión → ámbar/premium. Solo subidas relevantes; bajar es bueno.
      const prevPct = pct(c.commissionPrev)
      const currPct = pct(c.commissionCurr)
      if (currPct - prevPct >= MIN_COMMISSION_DELTA) {
        out.push(commissionUpSignal(c, name, prevPct, currPct))
      }
    }

    return out
  },
}

function jailedSignal(c: ValidatorChange, name: string): Signal {
  return {
    id: `validator-jailed-${c.address}`,
    level: 'red',
    tier: 'free',
    titleKey: 'health.jailed.title',
    descKey: 'health.jailed.desc',
    descParams: { name },
    icon: 'alert-circle-outline',
    action: { labelKey: 'health.action.redelegate', screen: 'Staking', params: { chain: 'klever' } },
  }
}

function deselectedSignal(c: ValidatorChange, name: string): Signal {
  return {
    id: `validator-deselected-${c.address}`,
    level: 'red',
    tier: 'free',
    titleKey: 'health.deselected.title',
    descKey: 'health.deselected.desc',
    descParams: { name },
    icon: 'remove-circle-outline',
    action: { labelKey: 'health.action.redelegate', screen: 'Staking', params: { chain: 'klever' } },
  }
}

function commissionUpSignal(
  c: ValidatorChange,
  name: string,
  prevPct: number,
  currPct: number,
): Signal {
  return {
    id: `validator-commission-${c.address}`,
    level: 'amber',
    tier: 'premium',
    titleKey: 'health.commissionUp.title',
    descKey: 'health.commissionUp.desc',
    descParams: { name, prev: round1(prevPct), curr: round1(currPct) },
    icon: 'trending-up-outline',
    action: { labelKey: 'health.action.redelegate', screen: 'Staking', params: { chain: 'klever' } },
    // Reaparece si vuelve a subir por encima del valor (en %) con el que se descartó.
    dismissRef: round1(currPct),
  }
}

export const validatorRules: Rule[] = [validatorChanges]
