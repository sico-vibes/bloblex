import { useId } from 'react'
import type { ThemeStyle } from './appearance'
import './lookOrb.css'

/** A static, decorative material swatch for one of the app's looks. */
export function LookOrb({ look, size }: { look: ThemeStyle; size: number }) {
  const clipId = `look-orb-${useId().replace(/:/g, '')}`
  return <svg className="look-orb" data-look={look} aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 100 100">
    {look === 'bitbots' && <>
      <defs><radialGradient id={`${clipId}-frost`} cx="25%" cy="20%" r="90%"><stop stopColor="#f4fbff" /><stop offset=".45" stopColor="#b6cbdc" /><stop offset="1" stopColor="#678397" /></radialGradient><clipPath id={`${clipId}-frost-clip`}><circle cx="50" cy="50" r="47" /></clipPath></defs>
      <circle cx="50" cy="50" r="47" fill={`url(#${clipId}-frost)`} />
      <g clipPath={`url(#${clipId}-frost-clip)`}><rect x="15" y="19" width="60" height="47" rx="11" fill="#fff" fillOpacity=".28" stroke="#fff" strokeOpacity=".65" /><rect x="33" y="40" width="55" height="44" rx="10" fill="#e7f3fc" fillOpacity=".4" stroke="#fff" strokeOpacity=".7" /></g>
      <circle cx="50" cy="50" r="47" fill="none" stroke="#fff" strokeOpacity=".8" strokeWidth="2" />
    </>}
    {look === 'blobots' && <>
      <defs><radialGradient id={`${clipId}-stone`} cx="31%" cy="25%" r="78%"><stop stopColor="#777" /><stop offset=".52" stopColor="#505050" /><stop offset="1" stopColor="#292929" /></radialGradient></defs>
      <circle cx="50" cy="50" r="48" fill={`url(#${clipId}-stone)`} />
      <circle cx="50" cy="50" r="47.25" fill="none" stroke="#8b8b8b" strokeOpacity=".42" strokeWidth="1.5" />
    </>}

  </svg>
}
