/**
 * Utilities for NIP (Polish tax identification number) validation and formatting
 */

/** Usuwa wszystko poza cyframi, max 10 cyfr */
export function normalizeNIP(nip: string): string {
  return nip.replace(/[^\d]/g, '').slice(0, 10);
}

/** Formatuje NIP do wyświetlenia: 1234567890 → 123-456-78-90 */
export function formatNIP(nip: string): string {
  const normalized = normalizeNIP(nip);
  if (normalized.length !== 10) return normalized;
  return `${normalized.slice(0, 3)}-${normalized.slice(3, 6)}-${normalized.slice(6, 8)}-${normalized.slice(8)}`;
}

/** Walidacja NIP - format i suma kontrolna */
export function validateNIP(nip: string): boolean {
  const normalized = normalizeNIP(nip);
  if (normalized.length !== 10) return false;
  
  // Suma kontrolna wg algorytmu: https://pl.wikipedia.org/wiki/NIP
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const digits = normalized.split('').map(Number);
  const sum = weights.reduce((acc, w, i) => acc + w * digits[i], 0);
  return sum % 11 === digits[9];
}

/** Auto-formatowanie w trakcie pisania */
export function autoFormatNIP(input: string): string {
  const digits = normalizeNIP(input);
  let result = '';
  if (digits.length > 0) result += digits.slice(0, 3);
  if (digits.length > 3) result += '-' + digits.slice(3, 6);
  if (digits.length > 6) result += '-' + digits.slice(6, 8);
  if (digits.length > 8) result += '-' + digits.slice(8, 10);
  return result;
}

/** Typy statusu walidacji NIP */
export type NIPValidationStatus = 'empty' | 'invalid' | 'checking' | 'exists' | 'available' | 'error';

export interface NIPCheckResult {
  exists: boolean;
  normalizedNip: string;
  contractor?: {
    id: number;
    name: string;
    nip: string;
    address: string | null;
    city: string | null;
    phone: string | null;
    email: string | null;
  };
}
