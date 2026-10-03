import { IslandStateMachine, type FsmState } from './engine/island/fsm'

export type CompanionMode = FsmState

/**
 * Thin Bloblex adapter around the island FSM. Its only behavior override
 * is approval pinning; shell placement and floating visibility are handled by
 * the companion window adapter.
 */
export class CompanionFsm extends IslandStateMachine {
  // After the greeting ends the island rests a moment before shrinking to the compact bar.
  override greetAutoCollapseDelay = 1.4
  mouseLeft() {
    super.mouseLeft()
    // A freely positioned overlay must not vanish into an unknown desktop
    // location. Preserve upstream home/greeting transitions but cancel only
    // compact auto-hide; the user has an explicit Hide companion control.
    if (this.state === 'petit') this.cancelTimers()
  }

  reveal() {
    super.reveal()
    if (this.state === 'petit') this.cancelTimers()
  }

  forceHome(pin = this.pinned) {
    this.pinned = pin
    super.forceHome()
  }

  forcePetit(forcePinned = false) {
    if (this.pinned && !forcePinned) return
    this.pinned = false
    super.forcePetit()
  }

  forceHidden() {
    this.pinned = false
    super.forceHidden()
  }

  dispose() {
    this.cancelTimers()
    this.onTransition = null
  }
}
