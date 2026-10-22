import { useEffect, useRef } from 'react'

/** Move only the face; small sidebar avatars do not subscribe to pointer events. */
export function useEyeTracking(enabled: boolean, distance = 3) {
  const ref = useRef<SVGGElement>(null)
  useEffect(() => {
    if (!enabled) return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    const reset = () => { cancelAnimationFrame(frame); frame = 0; ref.current?.removeAttribute('transform') }
    const move = (event: PointerEvent) => {
      if (media.matches || !ref.current) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const element = ref.current
        const bounds = element?.ownerSVGElement?.getBoundingClientRect()
        if (!element || !bounds?.width || !bounds.height) return
        const x = Math.max(-1, Math.min(1, (event.clientX - bounds.left - bounds.width / 2) / (bounds.width * 2))) * distance
        const y = Math.max(-1, Math.min(1, (event.clientY - bounds.top - bounds.height / 2) / (bounds.height * 2))) * distance
        element.setAttribute('transform', `translate(${x} ${y})`)
      })
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('blur', reset)
    document.addEventListener('pointerleave', reset)
    media.addEventListener?.('change', reset)
    return () => { reset(); window.removeEventListener('pointermove', move); window.removeEventListener('blur', reset); document.removeEventListener('pointerleave', reset); media.removeEventListener?.('change', reset) }
  }, [enabled, distance])
  return ref
}
