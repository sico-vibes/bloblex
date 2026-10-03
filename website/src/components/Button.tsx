import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

type ButtonBaseProps = {
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'default' | 'small'
  children: ReactNode
  className?: string
}

type ButtonAsButton = ButtonBaseProps & ButtonHTMLAttributes<HTMLButtonElement> & { as?: 'button' }
type ButtonAsLink = ButtonBaseProps & AnchorHTMLAttributes<HTMLAnchorElement> & { as: 'a' }

type ButtonProps = ButtonAsButton | ButtonAsLink

export function Button({ variant = 'primary', size = 'default', className, children, as, ...props }: ButtonProps) {
  const classes = cn(
    'inline-flex items-center justify-center gap-2 rounded-pill font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/55 disabled:cursor-not-allowed disabled:opacity-40',
    {
      'bg-text-1 text-text-inverse hover:bg-white': variant === 'primary',
      'border border-white/15 bg-transparent text-text-1 hover:bg-white/5': variant === 'secondary',
      'bg-transparent text-text-2 hover:bg-white/5 hover:text-text-1': variant === 'ghost',
    },
    {
      'h-8 px-4 text-sm': size === 'default',
      'h-7 px-3 text-xs': size === 'small',
    },
    className
  )

  if (as === 'a') {
    return (
      <a className={classes} {...(props as AnchorHTMLAttributes<HTMLAnchorElement>)}>
        {children}
      </a>
    )
  }

  return (
    <button className={classes} {...(props as ButtonHTMLAttributes<HTMLButtonElement>)}>
      {children}
    </button>
  )
}
