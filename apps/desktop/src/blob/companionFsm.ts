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
  private greeted = false

  launch() {
    this.greeted = false
    super.launch()
  }

  greetComplete() {
    this.greeted = true
    super.greetComplete()
  }

  mouseLeft() {
    // The welcome greeting always plays to the end: moving the pointer off the
    // island must not cut it short. Leaving drops the long hover hold, so the
    // island rests briefly after the greeting and then shrinks.
    if (this.state === 'welcome') {
      this.clear('greetCollapse')
      if (this.greeted) this.scheduleGreetCollapse(this.greetAutoCollapseDelay)
      return
    }
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
