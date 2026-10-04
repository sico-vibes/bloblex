const CURRENCY_DIGITS: Record<string, number> = { BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KRW: 0, PYG: 0, UGX: 0, VND: 0, XAF: 0, XOF: 0, XPF: 0, BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3 }

export function currencyDigits(currency: string): number {
  return CURRENCY_DIGITS[currency.toUpperCase()] ?? 2
}

export function majorToMinor(value: string, currency: string, allowZero = false): number | null {
  const trimmed = value.trim()
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null
  const digits = currencyDigits(currency)
  const [whole = '', fraction = ''] = trimmed.split('.')
  if (fraction.length > digits && /[1-9]/.test(fraction.slice(digits))) return null
  const padded = (fraction.slice(0, digits) + '0'.repeat(digits)).slice(0, digits)
  const amount = Number(whole) * (10 ** digits) + Number(padded || '0')
  return Number.isSafeInteger(amount) && (allowZero ? amount >= 0 : amount > 0) ? amount : null
}

export function minorToMajor(value: unknown, currency: string): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return ''
  const digits = currencyDigits(currency)
  return digits === 0 ? String(value) : (value / (10 ** digits)).toFixed(digits)
}

export function validPriceRate(value: string): boolean {
  const trimmed = value.trim()
  return /^\d{1,12}(?:\.\d{1,12})?$/.test(trimmed)
}

export function formatMinor(value: unknown, currency: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return 'Unknown'
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value / (10 ** currencyDigits(currency))) }
  catch { return 'Unknown' }
}

export function formatCount(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value) : 'Unknown'
}

export function priceRuleParams(rule: Record<string, unknown>) {
  return {
    id: rule.id,
    provider: rule.provider,
    canonicalModelId: rule.canonicalModelId ?? rule.model,
    aliases: Array.isArray(rule.aliases) ? rule.aliases : [],
    inputPerMillion: rule.inputPerMillion,
    outputPerMillion: rule.outputPerMillion,
    cacheReadPerMillion: rule.cacheReadPerMillion,
    cacheWritePerMillion: rule.cacheWritePerMillion,
    currency: rule.currency,
    effectiveFrom: rule.effectiveFrom ?? new Date().toISOString(),
    effectiveTo: rule.effectiveTo ?? null,
    sourceUrl: rule.sourceUrl ?? null,
  }
}
