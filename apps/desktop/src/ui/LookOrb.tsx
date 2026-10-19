import { useId } from 'react'
import type { ThemeStyle } from './appearance'
import './lookOrb.css'

/** A static, decorative material swatch for one of the app's looks. */
export function LookOrb({ look, size }: { look: ThemeStyle; size: number }) {
  const clipId = `look-orb-${useId().replace(/:/g, '')}`
  const isLegacyPixel = (x: number, y: number) => (x - 6.5) ** 2 + (y - 6.5) ** 2 <= 6.7 ** 2
  const legacyPixels = Array.from({ length: 14 * 14 }, (_, index) => {
    const x = index % 14
    const y = Math.floor(index / 14)
    if (!isLegacyPixel(x, y)) return null
    const outline = [-1, 0, 1].some((dx) => [-1, 0, 1].some((dy) =>
      (dx !== 0 || dy !== 0) && !isLegacyPixel(x + dx, y + dy)))
    const ditherZone = x >= 5 && y >= 5 && x + y >= 11
    const terracotta = !outline && ditherZone && (x + y) % 2 === 0
    const fill = outline ? '#3a3a3a' : terracotta ? '#e17a56' : '#141414'
    return <rect key={index} x={x} y={y} width="1" height="1" fill={fill} />
  })
  const dots = Array.from({ length: 49 }, (_, index) => {
    const x = 20 + (index % 7) * 10
    const y = 20 + Math.floor(index / 7) * 10
    const lit = (x === 40 && y === 30) || (x === 60 && y === 40) || (x === 30 && y === 50)
    const red = x === 70 && y === 30
    return <circle key={index} cx={x} cy={y} r="2" className={red ? 'look-orb-dot-red' : lit ? 'look-orb-dot-lit' : 'look-orb-dot-unlit'} />
  })

  return <svg className="look-orb" data-look={look} aria-hidden="true" focusable="false" width={size} height={size} viewBox={look === 'legacy' ? '0 0 14 14' : '0 0 100 100'}>
    {look === 'bitbots' && <>
      <defs>
        <linearGradient id={`${clipId}-lake`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#b7cfe8" /><stop offset=".55" stopColor="#e8e3ee" /><stop offset=".8" stopColor="#f6dcc8" /></linearGradient>
        <clipPath id={`${clipId}-clip`}><circle cx="50" cy="50" r="48" /></clipPath>
      </defs>
      <g clipPath={`url(#${clipId}-clip)`}>
        <rect width="100" height="100" fill={`url(#${clipId}-lake)`} />
        <path d="M0 58 Q19 48 36 57 T70 55 T100 54 V100 H0Z" fill="#a9bfd3" />
        <path d="M0 66 Q18 60 37 67 T72 64 T100 66 V100 H0Z" fill="#86a3bc" />
        <path d="M0 75 Q23 70 48 76 T100 74 V100 H0Z" fill="#c3d6e6" />
        <circle cx="29" cy="42" r="7" fill="#fff4e4" opacity=".72" />
        <circle cx="50" cy="50" r="48" fill="#ffffff" opacity=".24" />
      </g>
      <circle cx="50" cy="50" r="48" fill="none" stroke="#fff" strokeOpacity=".78" strokeWidth="1.5" />
    </>}
    {look === 'blobots' && <>
      <defs><radialGradient id={`${clipId}-stone`} cx="31%" cy="25%" r="78%"><stop stopColor="#777" /><stop offset=".52" stopColor="#505050" /><stop offset="1" stopColor="#292929" /></radialGradient></defs>
      <circle cx="50" cy="50" r="48" fill={`url(#${clipId}-stone)`} />
      <circle cx="50" cy="50" r="47.25" fill="none" stroke="#8b8b8b" strokeOpacity=".42" strokeWidth="1.5" />
    </>}
    {look === 'legacy' && <g className="look-orb-legacy-pixels">{legacyPixels}</g>}
    {look === 'pop' && <>
      <defs><clipPath id={`${clipId}-pop-clip`}><circle cx="50" cy="50" r="46" /></clipPath></defs>
      <circle className="look-orb-pop-base" cx="50" cy="50" r="47" />
      <g clipPath={`url(#${clipId}-pop-clip)`}>
        <path d="M-8 38 38-8 51 5 5 51Z" fill="#f6cf5c" />
        <path d="M12 58 58 12 71 25 25 71Z" fill="#8fdcb6" />
        <path d="M32 78 78 32 91 45 45 91Z" fill="#f59a8c" />
        <path d="M52 98 98 52 111 65 65 111Z" fill="#f6cf5c" />
      </g>
      <circle cx="50" cy="50" r="47" fill="none" stroke="#1d1b18" strokeWidth="2" />
    </>}
    {look === 'dot' && <>
      <defs><clipPath id={`${clipId}-dot-clip`}><circle cx="50" cy="50" r="48" /></clipPath></defs>
      <circle cx="50" cy="50" r="48" fill="#0e0e0e" />
      <g clipPath={`url(#${clipId}-dot-clip)`}>{dots}</g>
      <circle cx="50" cy="50" r="48" fill="none" stroke="#262626" strokeWidth="2" />
    </>}
  </svg>
}
