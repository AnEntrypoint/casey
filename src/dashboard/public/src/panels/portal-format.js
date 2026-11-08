const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
const BYTE_STEP = 1024;

export const STEP_MS = { hour: 3600000, day: 86400000 };

export function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return '-';
  let value = Math.max(0, n);
  let unit = 0;
  while (value >= BYTE_STEP && unit < BYTE_UNITS.length - 1) {
    value /= BYTE_STEP;
    unit++;
  }
  const shown = unit === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return shown + ' ' + BYTE_UNITS[unit];
}

export function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return '-';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return days + 'd ' + hours + 'h';
  if (hours) return hours + 'h ' + minutes + 'm';
  return minutes + 'm';
}

export const hoursAgoIso = (hours) => new Date(Date.now() - hours * STEP_MS.hour).toISOString();
