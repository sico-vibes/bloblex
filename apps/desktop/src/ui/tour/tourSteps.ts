import type { Placement } from './placement'

export interface TourStep {
  id: string
  /** `data-tour` value of the element the step points at. */
  anchor: string
  placement: Placement
  title: string
  body: string
  /** A short action line shown in a quieter style under the body. */
  tip?: string
}

/**
 * The six stops of the first-run tour. Copy is a function of the look's
 * noun so Bitbots says "bot" and Blobots says "blob". Steps whose anchor is
 * not on screen (a panel closed, a narrow window, a build with no remote
 * support) are skipped by the tour.
 */
export function tourSteps(noun: string, plural: string): TourStep[] {
  return [
    {
      id: 'roster', anchor: 'roster', placement: 'right',
      title: `Your ${plural} live here`,
      body: `Each row is one ${noun}. A dot appears only while one is working or needs you.`,
      tip: 'Click a row to open its conversations.',
    },
    {
      id: 'composer', anchor: 'composer', placement: 'top',
      title: 'Give it a task',
      body: `Describe what you want done. Type @ to bring in another ${noun}, use + to attach files, or dictate with the microphone.`,
      tip: 'Enter sends. Shift+Enter adds a line.',
    },
    {
      id: 'controls', anchor: 'controls', placement: 'top',
      title: 'Choose the model and how hard it thinks',
      body: 'Higher effort is slower but more thorough. "Ask first" means you approve each change before it happens.',
    },
    {
      id: 'plan', anchor: 'plan', placement: 'top',
      title: 'See the plan before anything runs',
      body: `Turn on Plan and the ${noun} proposes steps for you to approve. Permission requests appear in the conversation, where you can allow once or deny.`,
    },
    {
      id: 'companion', anchor: 'companion', placement: 'right',
      title: `Keep a ${noun} on your desktop`,
      body: `The companion floats above your other windows and shows when a ${noun} needs you. Ctrl+Alt+B shows or hides it.`,
      tip: 'Change the look and accent colour any time in Settings > Appearance.',
    },
    {
      id: 'remote', anchor: 'remote', placement: 'right',
      title: `Reach your ${plural} from anywhere`,
      body: `Turn on Remote in Settings to chat with your ${plural} from a phone or another browser. You choose which devices, and what they may do.`,
      tip: 'Off by default. Nothing connects until you say so.',
    },
  ]
}
