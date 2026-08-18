import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** Pulsing placeholder used to mirror content layout while it loads. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-sm bg-muted', className)} {...props} />
}
