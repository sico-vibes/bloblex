// Test helpers for the custom Select dropdown (not a test file itself).
import { act } from 'react'

export function selectTrigger(root: ParentNode, label: string) {
  return root.querySelector<HTMLButtonElement>(`.select-trigger[aria-label="${label}"]`)
}

export function selectValue(root: ParentNode, label: string) {
  return selectTrigger(root, label)?.getAttribute('data-value') ?? null
}

export async function openSelect(root: ParentNode, label: string) {
  const trigger = selectTrigger(root, label)
  if (!trigger) throw new Error(`No dropdown labelled ${label}`)
  if (trigger.getAttribute('aria-expanded') !== 'true') await act(async () => { trigger.click() })
  const list = trigger.parentElement?.querySelector<HTMLElement>('[role="listbox"]')
  if (!list) throw new Error(`Dropdown ${label} did not open`)
  return list
}

/** Opens the dropdown, reads its options and closes it again. */
export async function selectOptions(root: ParentNode, label: string) {
  const list = await openSelect(root, label)
  const options = [...list.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => ({ value: option.getAttribute('data-value') ?? '', label: option.textContent ?? '', disabled: option.getAttribute('aria-disabled') === 'true' }))
  await act(async () => { selectTrigger(root, label)?.click() })
  return options
}

export async function chooseOption(root: ParentNode, label: string, value: string) {
  const list = await openSelect(root, label)
  const option = [...list.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.getAttribute('data-value') === value)
  if (!option) throw new Error(`Dropdown ${label} has no option ${value}`)
  await act(async () => { option.click() })
}

export async function chooseOptionByLabel(root: ParentNode, label: string, text: string) {
  const list = await openSelect(root, label)
  const option = [...list.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent === text)
  if (!option) throw new Error(`Dropdown ${label} has no option labelled ${text}`)
  await act(async () => { option.click() })
}
