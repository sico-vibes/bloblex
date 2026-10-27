import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'success' | 'working'
}

export function Badge({ variant = 'default', className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-pill px-2.5 py-0.5 text-xs font-medium',
        {
          'bg-white/10 text-text-2': variant === 'default',
          'bg-success/20 text-success': variant === 'success',
          'bg-working/20 text-working': variant === 'working',
        },
        className
      )}
      {...props}
    />
  )
}
