import type { DcContainer } from '@shared/types';

/**
 * Ports that speak something other than HTTP (mail, databases, queues): a web UI next to them wins (Mailpit: 8025 over
 * 1025). Every port an image exposes counts, so the extra ones official images open belong here too — mysql:8 exposes
 * 3306 and 33060 (X Protocol), rabbitmq 4369 / 5671 / 25672 beside 5672: one missing gave MySQL a domain.
 */
export const NOT_WEB = [
  // mail
  25, 465, 587, 1025, 2525,
  // SQL: postgres (and a second one), MySQL / MariaDB (+ X Protocol), SQL Server, Oracle, Db2, CockroachDB
  5432, 5433, 3306, 33060, 1433, 1521, 50000, 26257,
  // key-value, documents, graphs, wide columns
  6379, 6380, 11211, 27017, 7687, 9042,
  // queues and brokers: RabbitMQ (+ epmd, TLS, clustering), NATS (+ cluster), Kafka, ZooKeeper, MQTT, ActiveMQ
  5672, 5671, 4369, 25672, 4222, 6222, 9092, 2181, 1883, 8883, 61616,
];
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
