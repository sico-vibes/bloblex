import { useId } from 'react'
import type { ThemeStyle } from './appearance'
import './lookOrb.css'

/** A static, decorative material swatch for one of the app's looks. */
export function LookOrb({ look, size }: { look: ThemeStyle; size: number }) {
  const clipId = `look-orb-${useId().replace(/:/g, '')}`
  return <svg className="look-orb" data-look={look} aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 100 100">
    {look === 'bitbots' && <>
      <defs><radialGradient id={`${clipId}-frost`} cx="30%" cy="24%" r="85%"><stop stopColor="#9fb4c4" /><stop offset=".5" stopColor="#3f5463" /><stop offset="1" stopColor="#18222a" /></radialGradient><linearGradient id={`${clipId}-frost-pane`} x1="0" x2="0" y1="0" y2="1"><stop stopColor="#e6f2fb" stopOpacity=".42" /><stop offset="1" stopColor="#bcd6ea" stopOpacity=".14" /></linearGradient><clipPath id={`${clipId}-frost-clip`}><circle cx="50" cy="50" r="47" /></clipPath></defs>
      <circle cx="50" cy="50" r="47" fill={`url(#${clipId}-frost)`} />
      <g clipPath={`url(#${clipId}-frost-clip)`}><rect x="10" y="36" width="90" height="28" rx="11" fill={`url(#${clipId}-frost-pane)`} stroke="#fff" strokeOpacity=".45" strokeWidth="1" /></g>
      <circle cx="50" cy="50" r="47" fill="none" stroke="#fff" strokeOpacity=".28" strokeWidth="1.5" />
    </>}
    {look === 'haze' && <>
      <defs><radialGradient id={`${clipId}-haze`} cx="30%" cy="24%" r="85%"><stop stopColor="#8a8f96" /><stop offset=".5" stopColor="#3b3d42" /><stop offset="1" stopColor="#1b1c1f" /></radialGradient><linearGradient id={`${clipId}-haze-wave`} x1="0" x2="1"><stop stopColor="#ef8354" stopOpacity="0" /><stop offset=".55" stopColor="#ef8354" stopOpacity=".55" /><stop offset="1" stopColor="#f6d27a" stopOpacity=".9" /></linearGradient><clipPath id={`${clipId}-haze-clip`}><circle cx="50" cy="50" r="47" /></clipPath></defs>
      <circle cx="50" cy="50" r="47" fill={`url(#${clipId}-haze)`} />
      <g clipPath={`url(#${clipId}-haze-clip)`}><rect x="10" y="38" width="90" height="24" rx="10" fill={`url(#${clipId}-haze-wave)`} /></g>
      <circle cx="50" cy="50" r="47" fill="none" stroke="#fff" strokeOpacity=".28" strokeWidth="1.5" />
    </>}
    {look === 'blobots' && <>
      <defs><radialGradient id={`${clipId}-stone`} cx="31%" cy="25%" r="78%"><stop stopColor="#777" /><stop offset=".52" stopColor="#505050" /><stop offset="1" stopColor="#292929" /></radialGradient><linearGradient id={`${clipId}-stone-band`} x1="0" x2="1"><stop stopColor="#bdbdbd" stopOpacity="0" /><stop offset=".55" stopColor="#bdbdbd" stopOpacity=".38" /><stop offset="1" stopColor="#ececec" stopOpacity=".75" /></linearGradient><clipPath id={`${clipId}-stone-clip`}><circle cx="50" cy="50" r="47" /></clipPath></defs>
      <circle cx="50" cy="50" r="48" fill={`url(#${clipId}-stone)`} />
      <g clipPath={`url(#${clipId}-stone-clip)`}><rect x="10" y="38" width="90" height="24" rx="10" fill={`url(#${clipId}-stone-band)`} /></g>
      <circle cx="50" cy="50" r="47.25" fill="none" stroke="#8b8b8b" strokeOpacity=".42" strokeWidth="1.5" />
    </>}

  </svg>
}
