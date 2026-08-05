import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, HeartPulse, House, List, Stethoscope, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LanguageMenu } from './LanguageMenu'

export type InsuranceType = 'life' | 'property_casualty'
type NavSection = 'upload' | 'jobs' | 'manual'

interface AppTopBarProps {
  /** Which nav destination is currently active, if any. */
  activeSection?: NavSection
  /** Line-of-business toggle state. Omit to hide the toggle (non-landing screens). */
  insuranceType?: InsuranceType
  onInsuranceTypeChange?: (type: InsuranceType) => void
}

/**
 * Shared top navigation bar. Two clusters on a hairline rule: brand + Life/P&C
 * toggle on the left; Jobs · Manual — divider — language · Upload on the right.
 * Upload is the single filled primary action; every other control is plain text.
 * Mirrors the "App Top Bar" component in designs/underwriting workbench.pen.
 */
export function AppTopBar({
  activeSection,
  insuranceType,
  onInsuranceTypeChange,
}: AppTopBarProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const segmentClass = (active: boolean) =>
    cn(
      'flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-[13px] transition-colors',
      active
        ? 'bg-secondary font-semibold text-foreground'
        : 'font-medium text-muted-foreground hover:text-foreground',
    )

  const navLinkClass = (active: boolean) =>
    cn(
      'flex items-center rounded-sm px-4 py-2 text-[13.5px] font-medium transition-colors',
      active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
    )

  return (
    <header className="flex h-16 items-center justify-between border-b border-border bg-card px-10">
      {/* Left cluster: brand + line-of-business toggle */}
      <div className="flex items-center gap-6">
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

        {insuranceType && (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => onInsuranceTypeChange?.('life')}
              className={segmentClass(insuranceType === 'life')}
            >
              <HeartPulse className="size-3.5" />
              <span>{t('common.life')}</span>
            </button>
            <button
              type="button"
              onClick={() => onInsuranceTypeChange?.('property_casualty')}
              className={segmentClass(insuranceType === 'property_casualty')}
            >
              <House className="size-3.5" />
              <span>{t('common.propertyAndCasualty')}</span>
            </button>
          </div>
        )}
      </div>

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
