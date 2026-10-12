import type { CatalogModel } from '../executionContract'

function numericGeneration(model: CatalogModel): number[] {
  const id = model.id.split('/').at(-1) ?? model.id
  const fromId = id.match(/\d+/g)?.map(Number) ?? []
  return fromId.length ? fromId : model.displayName.match(/\d+/g)?.map(Number) ?? []
}

function releaseTime(model: CatalogModel): number | null {
  if (!model.releaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(model.releaseDate)) return null
  const time = Date.parse(`${model.releaseDate}T00:00:00Z`)
  return Number.isFinite(time) ? time : null
}

/** Newer first. Generation breaks ties and orders new undated IDs against known older releases. */
function compareNewest(left: CatalogModel, right: CatalogModel): number {
  const leftDate = releaseTime(left)
  const rightDate = releaseTime(right)
  if (leftDate !== null && rightDate !== null && leftDate !== rightDate) return rightDate - leftDate
  const a = numericGeneration(left)
  const b = numericGeneration(right)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0)
    if (difference) return difference
  }
  if (leftDate !== null && rightDate === null) return -1
  if (leftDate === null && rightDate !== null) return 1
  return left.id.localeCompare(right.id)
}

function newest(models: readonly CatalogModel[]): CatalogModel | null {
  return [...models].sort(compareNewest)[0] ?? null
}

/** Product-selected first choices. They are stable provider policy, never a catalog recommendation. */
export function preferredConcreteModel(provider: string, models: readonly CatalogModel[]): CatalogModel | null {
  const key = provider.toLowerCase()
  if (key === 'claude') return newest(models.filter((model) => /(?:^|\/)claude-sonnet-/i.test(model.id)))
  if (key === 'codex') return newest(models.filter((model) => /^gpt-[\d.]+-luna$/i.test(model.id.split('/').at(-1) ?? model.id)))
  if (key === 'opencode') return models.find((model) => model.id === 'opencode/big-pickle') ?? null
  return null
}

export function concreteModelForSelection(provider: string, models: readonly CatalogModel[], selectedId: string | null | undefined) {
  return selectedId ? models.find((model) => model.id === selectedId) ?? null : preferredConcreteModel(provider, models)
}
