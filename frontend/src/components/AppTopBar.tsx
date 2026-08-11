import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, List, Stethoscope, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LanguageMenu } from './LanguageMenu'

type NavSection = 'upload' | 'jobs' | 'manual'

interface AppTopBarProps {
  /** Which nav destination is currently active, if any. */
  activeSection?: NavSection
}

/**
 * Shared top navigation bar. The brand sits on the left; Jobs · Manual —
 * divider — language · Upload on the right. Upload is the single filled primary
 * action; every other control is plain text. Mirrors the "App Top Bar"
 * component in designs/underwriting workbench.pen. (This solution is Life-only,
 * so there is no line-of-business toggle.)
 */
export function AppTopBar({ activeSection }: AppTopBarProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const navLinkClass = (active: boolean) =>
    cn(
      'flex items-center rounded-sm px-4 py-2 text-[13.5px] font-medium transition-colors',
      active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
    )

  return (
    <header className="flex h-16 items-center justify-between border-b border-border bg-card px-10">
      {/* Left cluster: brand */}
      <button
        type="button"
        onClick={() => navigate('/')}
        className="flex items-center gap-2.5 text-foreground"
      >
        <ShieldCheck className="size-[18px]" strokeWidth={2} />
        <span className="text-[15px] font-semibold tracking-[-0.2px]">
          {t('header.title')}
        </span>
      </button>

      {/* Right cluster: Jobs · Manual — divider — language · Upload */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => navigate('/jobs')}
          className={navLinkClass(activeSection === 'jobs')}
        >
          {t('header.jobs')}
        </button>
        <button
          type="button"
          onClick={() => navigate('/manual')}
          className={navLinkClass(activeSection === 'manual')}
        >
          {t('header.manual')}
        </button>

        <div className="flex items-center justify-center px-2.5">
          <div className="h-[18px] w-px bg-border" />
        </div>

        <LanguageMenu />

        <button
          type="button"
          onClick={() => navigate('/')}
          className="ml-0.5 flex items-center gap-1.5 rounded-sm bg-primary px-4 py-2 text-[13.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Upload className="size-3.5" />
          {t('header.upload')}
        </button>
      </div>
    </header>
  )
}

/** Icon lookup for nav sections, exported for reuse if needed elsewhere. */
export const navIcons = { jobs: List, manual: Stethoscope, upload: Upload }
