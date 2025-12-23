import i18n from '../i18n/config';

/**
 * API client utility that automatically adds language header to all requests
 */
export const apiClient = {
  /**
   * Fetch wrapper that adds X-User-Language header
   * @param url - The URL to fetch
   * @param options - Standard fetch options
   * @returns Promise with the fetch response
   */
  async fetch(url: string, options: RequestInit = {}): Promise<Response> {
    // Get current language from i18n
    const currentLanguage = i18n.language || 'en-US';
    
    // Merge headers with language header
    const headers = {
      ...options.headers,
      'X-User-Language': currentLanguage,
    };

    // Make the fetch request with updated headers
    return fetch(url, {
      ...options,
      headers,
    });
  },
};

