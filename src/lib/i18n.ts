/**
 * Internationalization utilities
 * Shared bilingual helper functions
 */
import { config } from '../config/index.js';

/**
 * Check if current language is Chinese
 */
export const isCn = (): boolean => config.novelLanguage === 'cn';

/**
 * Translate helper - returns Chinese or English based on config
 */
export const tr = (cn: string, en: string): string => isCn() ? cn : en;
