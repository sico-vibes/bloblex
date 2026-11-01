import { useState } from 'react'

/** An email stays blurred, for screenshots and screen shares, until it's clicked. Anything that isn't an email shows as it is. */
export function PrivateEmail({ text }: { text: string }) {
  const [revealed, setRevealed] = useState(false)
  if (!text.includes('@')) return <>{text}</>
  const action = revealed ? 'Hide email' : 'Reveal email'
  return <button type="button" className={`private-email${revealed ? ' revealed' : ''}`} aria-label={action} aria-pressed={revealed} title={action} onClick={(event) => { event.stopPropagation(); setRevealed((value) => !value) }}>
    <span aria-hidden={!revealed}>{text}</span>
  </button>
}
