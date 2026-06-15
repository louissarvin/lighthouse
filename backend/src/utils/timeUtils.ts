export const getCurrentTime = (): string => {
  return new Date().toISOString();
};

export const getCurrentTimeUnix = (): number => {
  return Math.floor(Date.now() / 1000);
};

export const convertDateToUnix = (date: Date): number => {
  return Math.floor(date.getTime() / 1000);
};

export const manyMinutesAgoUnix = (minutes: number): number => {
  return getCurrentTimeUnix() - minutes * 60;
};

/**
 * Convert a Unix timestamp (seconds) to a human-readable UTC string.
 */
export const unixToUtcString = (unix: number): string => {
  return new Date(unix * 1000).toUTCString();
};

/**
 * Returns true if `date` is older than `ttlMs` milliseconds.
 */
export const isExpired = (date: Date, ttlMs: number): boolean => {
  return Date.now() - date.getTime() > ttlMs;
};

/**
 * Format milliseconds as a human-readable duration (e.g. "2h 15m").
 */
export const formatDuration = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};
