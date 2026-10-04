export const OUTFITS = [
  'auto', 'none', 'party-hat', 'beanie', 'crown', 'sunglasses', 'round-glasses',
  'bow', 'scarf', 'witch-hat', 'santa-hat',
] as const

export type Outfit = typeof OUTFITS[number]

export const OUTFIT_LABELS: Record<Outfit, string> = {
  auto: 'Auto',
  none: 'None',
  'party-hat': 'Party hat',
  beanie: 'Beanie',
  crown: 'Crown',
  sunglasses: 'Sunglasses',
  'round-glasses': 'Round glasses',
  bow: 'Bow',
  scarf: 'Scarf',
  'witch-hat': 'Witch hat',
  'santa-hat': 'Santa hat',
}

export function isOutfit(value: unknown): value is Outfit {
  return typeof value === 'string' && (OUTFITS as readonly string[]).includes(value)
}

export function normalizeOutfit(value: unknown): Outfit {
  return isOutfit(value) ? value : 'auto'
}

/** Uses UTC calendar fields so the same stored creation date resolves identically on every device. */
export function seasonalOutfit(date: Date, createdAt?: string | null): Exclude<Outfit, 'auto'> {
  const month = date.getUTCMonth() + 1
  const day = date.getUTCDate()
  if (month === 10 && day >= 28 || month === 11 && day === 1) return 'witch-hat'
  if (month === 12 && day >= 20 && day <= 31) return 'santa-hat'
  if (month === 1 && day === 1) return 'party-hat'
  if (createdAt) {
    const created = new Date(createdAt)
    if (!Number.isNaN(created.getTime()) && created.getUTCMonth() === date.getUTCMonth() && created.getUTCDate() === day) return 'party-hat'
  }
  return 'none'
}

export function resolveOutfit(outfit: Outfit | null | undefined, date = new Date(), createdAt?: string | null): Exclude<Outfit, 'auto'> {
  const selection = normalizeOutfit(outfit)
  return selection === 'auto' ? seasonalOutfit(date, createdAt) : selection
}
