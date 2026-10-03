import * as RadixTabs from '@radix-ui/react-tabs'
import { cn } from '@/lib/utils'

export function Tabs({ children, ...props }: RadixTabs.TabsProps) {
  return <RadixTabs.Root {...props}>{children}</RadixTabs.Root>
}

export function TabsList({ className, ...props }: RadixTabs.TabsListProps) {
  return <RadixTabs.List className={cn('inline-flex items-center gap-1 rounded-md bg-white/5 p-1', className)} {...props} />
}

export function TabsTrigger({ className, ...props }: RadixTabs.TabsTriggerProps) {
  return (
    <RadixTabs.Trigger
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/55 disabled:pointer-events-none disabled:opacity-40',
        'text-text-2 hover:text-text-1',
        'data-[state=active]:bg-raised data-[state=active]:text-text-1',
        className
      )}
      {...props}
    />
  )
}

export function TabsContent({ className, ...props }: RadixTabs.TabsContentProps) {
  return <RadixTabs.Content className={cn('mt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/55', className)} {...props} />
}
