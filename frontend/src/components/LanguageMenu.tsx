import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LoadingOverlay } from './LoadingOverlay'

interface Locale {
  code: string
  name: string
  nativeName: string
}

// Kept in sync with i18n/config.ts and the backend SUPPORTED_LANGUAGES lists.
const SUPPORTED_LOCALES: Locale[] = [
  { code: 'en-US', name: 'English', nativeName: 'English' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'ja-JP', name: 'Japanese', nativeName: '日本語' },
  { code: 'es-ES', name: 'Spanish', nativeName: 'Español' },
  { code: 'fr-FR', name: 'French', nativeName: 'Français' },
  { code: 'fr-CA', name: 'French (Canadian)', nativeName: 'Français (CA)' },
  { code: 'de-DE', name: 'German', nativeName: 'Deutsch' },
  { code: 'it-IT', name: 'Italian', nativeName: 'Italiano' },
]

/**
 * Language switcher styled to the design's top-bar treatment: globe + native
 * name + chevron in muted-foreground. Retains the switching, persistence, and
 * keyboard behaviour of the legacy LanguageSelector.
 */
export function LanguageMenu() {
  const { i18n, t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const currentLocale =
    SUPPORTED_LOCALES.find((locale) => locale.code === i18n.language) ||
    SUPPORTED_LOCALES[0]

  const handleLanguageChange = async (localeCode: string) => {
    if (localeCode === i18n.language) {
      setIsOpen(false)
      return
    }

    setIsLoading(true)
    setIsOpen(false)

    try {
      await Promise.race([
        i18n.changeLanguage(localeCode),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Language change timeout')), 500),
        ),
      ])
      await new Promise((resolve) => setTimeout(resolve, 50))
    } catch (error) {
      console.warn('Language change failed or timed out:', error)
      try {
        localStorage.setItem('userLanguage', localeCode)
      } catch (storageError) {
        console.warn('Failed to save language preference:', storageError)
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  return (
    <>
      <LoadingOverlay
        isVisible={isLoading}
        message={t('common.switchingLanguage', 'Switching language...')}
      />

      <div className="relative" ref={containerRef}>
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          onKeyDown={(e) => e.key === 'Escape' && setIsOpen(false)}
          aria-label={t('common.selectLanguage', 'Select language')}
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          disabled={isLoading}
          className="flex items-center gap-1.5 rounded-sm px-2.5 py-2 text-[13.5px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          <Globe className="size-3.5" />
          <span className="hidden sm:inline">{currentLocale.nativeName}</span>
          <ChevronDown
            className={cn(
              'size-3 transition-transform',
              isOpen && 'rotate-180',
            )}
          />
        </button>

        {isOpen && (
          <div
            role="listbox"
            aria-label={t('common.availableLanguages', 'Available languages')}
            className="absolute right-0 top-full z-50 mt-1 min-w-[180px] overflow-hidden rounded-md border border-border bg-popover py-1 shadow-md"
          >
            {SUPPORTED_LOCALES.map((locale) => {
              const selected = locale.code === currentLocale.code
              return (
                <button
                  key={locale.code}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => handleLanguageChange(locale.code)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-accent',
                    selected
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground',
                  )}
                >
                  <span>{locale.nativeName}</span>
                  {selected && (
                    <Check
                      className="size-3.5 text-primary"
                      aria-label={t('common.selected', 'Selected')}
                    />
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
