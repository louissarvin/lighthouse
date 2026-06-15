import { customAlphabet } from 'nanoid';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const alphanumericNanoid = customAlphabet(alphabet, 16);

// custom alphabet, alphanumeric
export const getAlphanumericId = (length: number = 16): string => {
  return alphanumericNanoid(length);
};

export const shortenAddress = (address: string, startLength: number = 6, endLength: number = 4): string => {
  if (!address || address.length <= startLength + endLength) return address;
  return address.slice(0, startLength) + '...' + address.slice(-endLength);
};

/**
 * Format a bigint DUSDC amount (6 decimals) as a human-readable string.
 * e.g. 10_000_000n → "10.00"
 */
export const formatDusdc = (amount: bigint | number | string, decimals = 2): string => {
  const n = typeof amount === 'bigint' ? Number(amount) : Number(amount);
  return (n / 1_000_000).toFixed(decimals);
};

/**
 * Format a bigint SUI amount (9 decimals) as a human-readable string.
 * e.g. 1_000_000_000n → "1.0000"
 */
export const formatSui = (amount: bigint | number | string, decimals = 4): string => {
  const n = typeof amount === 'bigint' ? Number(amount) : Number(amount);
  return (n / 1_000_000_000).toFixed(decimals);
};
