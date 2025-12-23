import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpBackend from 'i18next-http-backend';

// Custom storage detector with fallback to sessionStorage
const customStorageDetector = {
  name: 'customStorage',

  lookup(): string | undefined {
    try {
      // Try localStorage first
      return localStorage.getItem('userLanguage') || undefined;
    } catch {
      try {
        // Fallback to sessionStorage
        return sessionStorage.getItem('userLanguage') || undefined;
      } catch {
        return undefined;
      }
    }
  },

  cacheUserLanguage(lng: string): void {
    try {
      // Try localStorage first
      localStorage.setItem('userLanguage', lng);
    } catch {
      try {
        // Fallback to sessionStorage
        sessionStorage.setItem('userLanguage', lng);
      } catch {
        // Language preference will not persist
      }
    }
  }
};

// Create language detector instance and add custom detector
const languageDetector = new LanguageDetector();
languageDetector.addDetector(customStorageDetector);

// Initialize i18next
i18n
  .use(HttpBackend)       // Load translations via HTTP
  .use(languageDetector)  // Use our configured language detector
  .use(initReactI18next)  // Passes i18n to react-i18next
  .init({
    fallbackLng: 'en-US',
    debug: false,

    // Supported languages
    supportedLngs: ['en-US', 'zh-CN', 'ja-JP', 'es-ES', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT'],

    // Namespace configuration
    ns: ['translation'],
    defaultNS: 'translation',

    // Interpolation configuration
    interpolation: {
      escapeValue: false, // React already escapes by default
    },

    // Language detection configuration
    detection: {
      // Order of detection methods - use custom storage first, then localStorage, then navigator
      order: ['customStorage', 'localStorage', 'navigator'],

      // Cache user language preference
      caches: ['customStorage', 'localStorage'],

      // localStorage key
      lookupLocalStorage: 'userLanguage',
    },

    // Backend configuration for loading translations
    backend: {
      loadPath: '/locales/{{lng}}/{{ns}}.json',
    },

    // Load all languages upfront to avoid race conditions
    load: 'currentOnly',

    // React configuration
    react: {
      useSuspense: false, // Prevent app crash on load failure
    },

    // Missing key handler
    saveMissing: true,
    missingKeyHandler: (lngs, ns, key) => {
      console.warn(`[i18n] Missing translation key: ${key} for locale: ${lngs[0]}`);
    },
  });

// Add language change listener to persist language preference and update HTML lang attribute
i18n.on('languageChanged', (lng) => {
  customStorageDetector.cacheUserLanguage(lng);
  
  // Update HTML lang attribute for accessibility
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lng;
  }
});

// Performance tracking for language switches (for monitoring)
if (typeof window !== 'undefined' && window.performance) {
  i18n.on('languageChanged', (lng) => {
    // Mark the language change completion for performance monitoring
    if (window.performance.mark) {
      window.performance.mark(`language-changed-${lng}`);
    }
  });
}

// Set initial HTML lang attribute
if (typeof document !== 'undefined' && i18n.language) {
  document.documentElement.lang = i18n.language;
}

export default i18n;

