import i18n from '../i18n/config';
import { fetchAuthSession } from 'aws-amplify/auth';

/**
 * API client utility that automatically adds language header and auth token to all requests
 */
export const apiClient = {
  /**
   * Fetch wrapper that adds X-User-Language and Authorization headers
   * @param url - The URL to fetch
   * @param options - Standard fetch options
   * @returns Promise with the fetch response
   */
  async fetch(url: string, options: RequestInit = {}): Promise<Response> {
    // Get current language from i18n
    const currentLanguage = i18n.language || 'en-US';

    // Get auth token
    let authToken: string | undefined;
    try {
      const session = await fetchAuthSession();
      authToken = session.tokens?.idToken?.toString();
    } catch {
      // Session fetch failed — proceed without auth header
    }

    // Merge headers with language and auth headers
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
      'X-User-Language': currentLanguage,
    };

    if (authToken) {
      headers['Authorization'] = authToken;
    }

    // Make the fetch request with updated headers
    return fetch(url, {
      ...options,
      headers,
    });
  },
};
