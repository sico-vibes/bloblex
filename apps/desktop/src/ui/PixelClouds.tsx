import { useEffect, useRef } from 'react'
import { useBitbots } from '../blob/bitbots'

const CELL = 4
const COLS = 160
const ROWS = 56
// Soft blobs of density that the dither is cut from: x, y, radius x, radius y (in cells).
const PUFFS: ReadonlyArray<readonly [number, number, number, number]> = [
  [40, 30, 34, 13], [74, 22, 30, 16], [108, 31, 38, 12], [22, 40, 20, 8], [128, 40, 22, 9],
]

function noise(x: number, y: number) {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return value - Math.floor(value)
}

/**
 * A drifting dither of pixel clouds, like the sky on the reference site. It is
 * decoration only: it exists while Bitbots is on, sits behind the content and
 * never takes the pointer.
 */
export function PixelClouds({ className = '' }: { className?: string }) {
  const bitbots = useBitbots()
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const element = canvas.current
    const ctx = element?.getContext('2d')
    if (!bitbots || !element || !ctx) return
    ctx.clearRect(0, 0, element.width, element.height)
    for (let gy = 0; gy < ROWS; gy++) {
      for (let gx = 0; gx < COLS; gx++) {
        let density = 0
        for (const [cx, cy, rx, ry] of PUFFS) {
          const distance = ((gx - cx) / rx) ** 2 + ((gy - cy) / ry) ** 2
          if (distance < 1) density += 1 - distance
        }
        if (density + (noise(gx, gy) - 0.5) * 0.7 < 0.5) continue
        ctx.fillStyle = `rgba(236, 232, 226, ${(0.1 + 0.34 * Math.min(1, density)).toFixed(2)})`
        ctx.fillRect(gx * CELL, gy * CELL, CELL - 1, CELL - 1)
      }
    }
  }, [bitbots])
  if (!bitbots) return null
  return <div className={`bb-clouds ${className}`} aria-hidden="true"><canvas ref={canvas} width={COLS * CELL} height={ROWS * CELL} /></div>
}
