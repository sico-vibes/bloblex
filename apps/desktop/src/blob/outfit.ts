export const OUTFITS = [
  'auto', 'none', 'party-hat', 'beanie', 'crown', 'sunglasses', 'round-glasses',
  'bow', 'scarf', 'witch-hat', 'pumpkin', 'santa-hat', 'bunny-ears',
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
  pumpkin: 'Pumpkin',
  'bunny-ears': 'Bunny ears',
}

export function isOutfit(value: unknown): value is Outfit {
  return typeof value === 'string' && (OUTFITS as readonly string[]).includes(value)
}

export function normalizeOutfit(value: unknown): Outfit {
  return isOutfit(value) ? value : 'auto'
}

function easterSunday(year: number): Date {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = (h + l - 7 * m + 114) % 31 + 1
  return new Date(year, month - 1, day)
}

/** Seasonal boundaries follow the user's local calendar. */
export function seasonalOutfit(date: Date): Exclude<Outfit, 'auto'> {
  const month = date.getMonth() + 1
  const day = date.getDate()
  const year = date.getFullYear()
  if (month === 12 && day === 31 || month === 1 && day <= 2) return 'party-hat'
  if (month === 12 && day <= 26) return 'santa-hat'
  if (month === 10 || month === 11 && day === 1) return 'witch-hat'
  const easter = easterSunday(year)
  const dayDelta = Math.round((new Date(year, month - 1, day).getTime() - easter.getTime()) / 86_400_000)
  if (dayDelta >= -2 && dayDelta <= 1) return 'bunny-ears'
  if (month === 6 && day >= 21 || month === 7 || month === 8) return 'sunglasses'
  return 'none'
}

export function resolveOutfit(outfit: Outfit | null | undefined, date = new Date(), _createdAt?: string | null): Exclude<Outfit, 'auto'> {
  const selection = normalizeOutfit(outfit)
  return selection === 'auto' ? seasonalOutfit(date) : selection
}
