import { Loader2 } from 'lucide-react'

interface LoadingOverlayProps {
  isVisible: boolean
  message?: string
}

/**
 * Full-screen loading scrim (shown e.g. while the UI language switches).
 * Token-bound so it resolves in both light and dark; the entrance fade and the
 * spinner collapse under prefers-reduced-motion (see index.css).
 */
export function LoadingOverlay({ isVisible, message = 'Loading...' }: LoadingOverlayProps) {
  if (!isVisible) return null

  return (
    <div
      data-testid="loading-overlay"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm duration-200 animate-in fade-in-0"
    >
      <div className="flex flex-col items-center gap-4 rounded-lg border border-border bg-card px-12 py-8 shadow-lg duration-300 animate-in fade-in-0 zoom-in-95">
        <Loader2 className="size-10 animate-spin text-primary" />
        <p className="text-[15px] font-medium text-foreground">{message}</p>
      </div>
    </div>
  )
}
