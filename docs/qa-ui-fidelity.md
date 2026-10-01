# Coucou UI fidelity checkpoint

Authority: user feedback and seven screenshots supplied on 1 October 2026; Coucou Windows source pinned to `8e12bed56134d2ee7165e73f132646b143ce56e4`. The user has redirected both Luna implementers to finish UI behavior and polish before further backend development. The full application goal remains active. Computer Use stays deferred until final implementation verification.

The original screenshots are now preserved with hash-verified copies in [ui-reference-images.md](ui-reference-images.md). They are review references, not product media or current Bloblex acceptance evidence.

## Review criteria

| Surface or behavior | Required result | Proof before acceptance |
| --- | --- | --- |
| Floating shell | Rounded rectangle with source-informed 14px compact and 22px expanded corners; no stadium-shaped outer pill. Bottom-center default, free drag and retained monitor-relative placement. | Geometry source review, build, final native observation. |
| Welcome | Centered character and both hands; growth, squint, dip/pop, wave, tuck, badge and settling follow the separate 4.6s greeting timeline. Collapse follows completion; hover extension and reduced motion work. | Timeline boundary fixtures, callback/FSM integration, final native launch. |
| Character identity | Mouth-free expressions throughout, including error and poke. Original Bloblex procedural art and provider palette remain; no protected character media is imported. | Draw-path review and final rendered state review. |
| Idle and online | Calm breathing, blinking and cursor gaze; online badge derives from an actual connected runtime. Offline cannot appear online. | State mapping and timing fixtures, final native observation. |
| Typing and thinking | Distinct typing/working and thinking expressions; text input and provider activity drive appropriate states. | State mapping fixtures and actual interaction. |
| Hover and poke | Hover growth and sustained-hover reaction; short poke squash; three rapid pokes produce dizzy eyes and a confused view, then recover to the prior view. | Threshold/timing fixtures and final input verification. |
| Completion and errors | Completion animation and actual result glance; distinct error/rate-limit/budget states with honest copy. Terminal states must not erase pending approvals. | Transition fixtures and final native evidence. |
| Expanded overview | Coucou-informed header, selected agent glance and runtime chips/cards use real Bloblex data. Navigation and collapse controls work and have accessible labels. | Source review and final native navigation. |
| Chat | Usable inline prompt/history and clear selected session; code/activity render safely; selection synchronizes across both windows. | Reducer/source checks and final native conversation. |
| File drop | Drag entry expands into a file-receive view, leave restores safely, drop prepares local attachment context, and the user can cancel or explicitly send it. Display only real progress/completion; animation alone is not an upload. | Native drag event mapping, local preparation/error tests, final file-drop check. |
| Permissions | Actual provider choices displayed opaquely, reject styled negative, approval pins the view and takes priority across sessions. No decorative approval success. | Contract source/fixtures and final live permission flow. |
| Motion and native layout | One canvas scheduler per character; hidden pauses; idle cadence is low; reduced motion static; native window resizing and CSS animation do not clip hands/cards. | Scheduler/native source checks and final native observation. |

## Current evidence

The latest settled independent UI checkpoint passed **55 tests across 12 files**, typecheck and a TypeScript/Vite production build (JS 379.56 kB / CSS 45.27 kB). Supported native development startup and a forced daemon rebuild while its private run copy stayed live were independently observed at the OS level. Gaze coordinate, StrictMode completion, reduced-motion dizzy recovery, file-after-thinking and appendage bounds findings have helper fixtures. Those checks prove their covered paths and launcher safety, not native fidelity. See [independent QA log](qa-ui-execution.md).

At 19:55 the existing lanes resumed UI work on approval deadlines, RuntimeExplainer/tray/settings coverage, mounted React lifecycle/state fixtures and original opt-in sound cues. These changes are in progress and are outside the settled 55-test checkpoint until QA independently verifies them. Computer Use/browser/native interaction remains deferred.

At 18:45 BST all three existing Luna lanes were dispatched follow-up UI work. Scope includes full plan UI coverage, remaining Coucou file-receive/drop interactions and structured usage/settings. Current usage JSON/field presentation and incomplete settings are open source gaps. No native Computer Use or browser interaction was resumed.

The user's screenshot of the older running Bloblex companion contradicts shape acceptance: its outer shell is a pill. Current source has 14px/22px rounded rectangular corners, but the current native rendering has not been observed. The previous 15 frontend tests and native launch prove that older runnable checkpoint, not fidelity; no revised UI acceptance is claimed yet.

Root independently compared the vendored `coucou/island/fsm.ts` against the pinned GitHub raw source: it is an exact copy after newline normalization. `CompanionFsm` now wraps that source rather than reproducing the state machine. Integration checks remain pending, including the upstream seconds-based timers and explicit navigation during greeting. Seven focused motion/greeting tests passed independently before the latest direct-source integration; that result does not cover subsequent edits.

Root also compared `coucou/core/anim.ts`: its code matches the pinned source after ignoring whitespace and the added provenance header. `DampedSpring` extends that imported `Spring`, so the source code is connected to the actual canvas and shell motion path. The supplied copyright notice is retained in `THIRD_PARTY_NOTICES.md`. Current integration review is tracking approval-pin preservation during navigation/file drag, native launch growth, stale activity priority, inline errors and card clipping.

Primary source references: [layout](https://raw.githubusercontent.com/Louis-CFM/coucou/8e12bed56134d2ee7165e73f132646b143ce56e4/windows/src/core/layout.ts), [greeting](https://raw.githubusercontent.com/Louis-CFM/coucou/8e12bed56134d2ee7165e73f132646b143ce56e4/windows/src/mochi/greeting.ts), [island](https://raw.githubusercontent.com/Louis-CFM/coucou/8e12bed56134d2ee7165e73f132646b143ce56e4/windows/src/island/island.ts), [character engine](https://raw.githubusercontent.com/Louis-CFM/coucou/8e12bed56134d2ee7165e73f132646b143ce56e4/windows/src/mochi/engine.ts).
