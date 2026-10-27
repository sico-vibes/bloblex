import characterOptions from './characters.json'

export const HAZE_CHARACTERS = characterOptions as readonly { readonly id: `char-${string}`; readonly name: string }[]
export type HazeCharacter = typeof HAZE_CHARACTERS[number]['id']
export const CHARACTER_LABELS = Object.fromEntries(HAZE_CHARACTERS.map(({ id, name }) => [id, name])) as Record<HazeCharacter, string>

const staticAssets = import.meta.glob('./characters/*/avatar.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const animatedAssets = import.meta.glob('./characters/*/animated.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>

export const CHARACTER_ASSETS = Object.fromEntries(HAZE_CHARACTERS.map(({ id }) => {
  const slug = id.slice('char-'.length)
  return [id, { static: staticAssets[`./characters/${slug}/avatar.svg`], animated: animatedAssets[`./characters/${slug}/animated.svg`] }]
})) as Record<HazeCharacter, { static: string; animated: string }>

export function isHazeCharacter(value: unknown): value is HazeCharacter {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CHARACTER_LABELS, value)
}
