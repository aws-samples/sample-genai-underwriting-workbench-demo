import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { LoadingOverlay } from './LoadingOverlay';
import '../styles/LanguageSelector.css';

interface Locale {
  code: string;
  name: string;
  nativeName: string;
  flag: string;
}

const SUPPORTED_LOCALES: Locale[] = [
  { code: 'en-US', name: 'English', nativeName: 'English', flag: '🇺🇸' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文', flag: '🇨🇳' },
  { code: 'ja-JP', name: 'Japanese', nativeName: '日本語', flag: '🇯🇵' },
  { code: 'es-ES', name: 'Spanish', nativeName: 'Español', flag: '🇪🇸' },
  { code: 'fr-FR', name: 'French', nativeName: 'Français', flag: '🇫🇷' },
  { code: 'fr-CA', name: 'French (Canadian)', nativeName: 'Français (CA)', flag: '🇨🇦' },
  { code: 'de-DE', name: 'German', nativeName: 'Deutsch', flag: '🇩🇪' },
  { code: 'it-IT', name: 'Italian', nativeName: 'Italiano', flag: '🇮🇹' },
];

interface LanguageSelectorProps {
  className?: string;
}

export function LanguageSelector({ className = '' }: LanguageSelectorProps) {
  const { i18n, t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentLocale = SUPPORTED_LOCALES.find(
    (locale) => locale.code === i18n.language
  ) || SUPPORTED_LOCALES[0];

  const handleLanguageChange = async (localeCode: string) => {
    // Don't show loading if selecting the same language
    if (localeCode === i18n.language) {
      setIsOpen(false);
      return;
    }

    // Show loading indicator
    setIsLoading(true);
    setIsOpen(false);

    try {
      // Change language with a timeout to ensure loading indicator is always removed
      await Promise.race([
        i18n.changeLanguage(localeCode),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Language change timeout')), 500)
        )
      ]);
      
      // Small delay to ensure translations are loaded and UI updates
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (error) {
      // Log error but don't show to user - fallback language will be used
      console.warn('Language change failed or timed out:', error);
      
      // Manually persist language preference even if change times out
      // This ensures the preference is saved for next session
      try {
        localStorage.setItem('userLanguage', localeCode);
      } catch (storageError) {
        console.warn('Failed to save language preference:', storageError);
      }
    } finally {
      // Always hide loading indicator
      setIsLoading(false);
    }
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Handle keyboard navigation with arrow keys
  const handleKeyDown = (event: React.KeyboardEvent, localeCode?: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (localeCode) {
        handleLanguageChange(localeCode);
      } else {
        setIsOpen(!isOpen);
      }
    } else if (event.key === 'Escape') {
      setIsOpen(false);
    } else if (isOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const currentIndex = SUPPORTED_LOCALES.findIndex(l => l.code === currentLocale.code);
      let nextIndex: number;
      
      if (event.key === 'ArrowDown') {
        nextIndex = (currentIndex + 1) % SUPPORTED_LOCALES.length;
      } else {
        nextIndex = (currentIndex - 1 + SUPPORTED_LOCALES.length) % SUPPORTED_LOCALES.length;
      }
      
      // Focus the next/previous option
      const options = dropdownRef.current?.querySelectorAll('.language-option');
      if (options && options[nextIndex]) {
        (options[nextIndex] as HTMLElement).focus();
      }
    }
  };

  return (
    <>
      <LoadingOverlay 
        isVisible={isLoading} 
        message={t('common.switchingLanguage', 'Switching language...')}
      />
      
      <div className={`language-selector ${className}`} ref={dropdownRef}>
        <button
          className="language-selector-button"
          onClick={() => setIsOpen(!isOpen)}
          onKeyDown={(e) => handleKeyDown(e)}
          aria-label={t('common.selectLanguage', 'Select language')}
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-controls="language-dropdown"
          disabled={isLoading}
          title={t('common.currentLanguage', `Current language: ${currentLocale.nativeName}`)}
        >
          <span className="language-flag" aria-hidden="true">{currentLocale.flag}</span>
          <span className="language-name">{currentLocale.nativeName}</span>
          <span className={`language-arrow ${isOpen ? 'open' : ''}`} aria-hidden="true">▼</span>
        </button>

        {isOpen && (
          <div 
            id="language-dropdown"
            className="language-dropdown" 
            role="listbox"
            aria-label={t('common.availableLanguages', 'Available languages')}
          >
            {SUPPORTED_LOCALES.map((locale) => (
              <button
                key={locale.code}
                className={`language-option ${
                  locale.code === currentLocale.code ? 'selected' : ''
                }`}
                onClick={() => handleLanguageChange(locale.code)}
                onKeyDown={(e) => handleKeyDown(e, locale.code)}
                role="option"
                aria-selected={locale.code === currentLocale.code}
                aria-label={`${locale.nativeName} (${locale.name})`}
                tabIndex={0}
              >
                <span className="language-flag" aria-hidden="true">{locale.flag}</span>
                <span className="language-name">{locale.nativeName}</span>
                {locale.code === currentLocale.code && (
                  <span className="language-checkmark" aria-label={t('common.selected', 'Selected')}>✓</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

