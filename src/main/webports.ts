import type { DcContainer } from '@shared/types';

/** Ports that speak something other than HTTP (mail, databases, queues): a web UI next to them wins (Mailpit: 8025 over 1025). */
export const NOT_WEB = [25, 465, 587, 1025, 2525, 5432, 3306, 6379, 27017, 5672, 11211, 4222, 1433, 9042];
/** A database, cache or mail server only (every port it exposes speaks something else): no page to open in a browser. */
export const isWeb = (c: Pick<DcContainer, 'ports'>): boolean => {
  const tcp = c.ports.filter((p) => p.type === 'tcp').map((p) => p.private);
  return !tcp.length || tcp.some((p) => !NOT_WEB.includes(p));
};
/** The address a non-web service has for the rest of its project (postgres:5432), or null. */
export const innerAddress = (c: Pick<DcContainer, 'ports' | 'service' | 'name'>): string | null => {
  const tcp = c.ports.filter((p) => p.type === 'tcp').map((p) => p.private);
  return tcp.length && !isWeb(c) ? `${c.service ?? c.name}:${Math.min(...tcp)}` : null;
};
