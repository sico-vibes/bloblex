import * as RadixAccordion from '@radix-ui/react-accordion'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Accordion({ children, ...props }: RadixAccordion.AccordionSingleProps | RadixAccordion.AccordionMultipleProps) {
  return <RadixAccordion.Root {...props}>{children}</RadixAccordion.Root>
}

export function AccordionItem({ className, ...props }: RadixAccordion.AccordionItemProps) {
  return <RadixAccordion.Item className={cn('border-b border-white/10', className)} {...props} />
}

export function AccordionTrigger({ className, children, ...props }: RadixAccordion.AccordionTriggerProps) {
  return (
    <RadixAccordion.Header className="flex">
      <RadixAccordion.Trigger
        className={cn(
          'flex flex-1 items-center justify-between py-4 text-left font-medium transition-all hover:text-text-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/55 [&[data-state=open]>svg]:rotate-180',
          'text-text-1',
          className
        )}
        {...props}
      >
        {children}
        <ChevronDown className="h-4 w-4 shrink-0 text-text-2 transition-transform duration-200" />
      </RadixAccordion.Trigger>
    </RadixAccordion.Header>
  )
}

export function AccordionContent({ className, children, ...props }: RadixAccordion.AccordionContentProps) {
  return (
    <RadixAccordion.Content className={cn('overflow-hidden text-sm data-[state=closed]:animate-[accordion-up_200ms_ease-out] data-[state=open]:animate-[accordion-down_200ms_ease-out]', className)} {...props}>
      <div className="pb-4 pt-0">{children}</div>
    </RadixAccordion.Content>
  )
}
