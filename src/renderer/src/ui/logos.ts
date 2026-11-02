/**
 * The logo for what a container runs, from its image name (postgres:17-alpine → PostgreSQL, bitnami/redis → Redis,
 * ghcr.io/axllent/mailpit → Mailpit). null = a container of its own (the generic container icon). Logos live in
 * assets/logos/svc (sources in assets/logos/SOURCES.md).
 */

const files = import.meta.glob('../assets/logos/svc/*.{png,svg}', { eager: true, import: 'default' }) as Record<string, string>;
const LOGO: Record<string, string> = Object.fromEntries(Object.entries(files).map(([path, url]) => [path.split('/').pop()!.replace(/\.(png|svg)$/, ''), url]));

/** Image name (last path part, no tag) → logo key; a name that is a key itself needs no entry. */
const ALIAS: Record<string, string> = {
  postgres: 'postgresql',
  postgis: 'postgresql',
  timescaledb: 'postgresql',
  pgvector: 'postgresql',
  mongo: 'mongodb',
  'redis-stack': 'redis',
  'redis-stack-server': 'redis',
  'valkey-bundle': 'valkey',
  'mysql-server': 'mysql',
  percona: 'mysql',
  'elasticsearch-oss': 'elasticsearch',
  kibana: 'elasticsearch',
  'opensearch-dashboards': 'opensearch',
  manticoresearch: 'manticore',
  'nginx-unprivileged': 'nginx',
  openresty: 'nginx',
  apache: 'httpd',
  'apache2': 'httpd',
  php: 'php',
  'php-fpm': 'php',
  bun: 'node',
  deno: 'node',
  go: 'golang',
  'rabbitmq-management': 'rabbitmq',
  'nats-streaming': 'nats',
  'clickhouse-server': 'clickhouse',
  'seaweedfs-server': 'seaweedfs',
};

export interface ServiceLook {
  /** The logo's URL, or null for the generic container icon. */
  logo: string | null;
  /** What it is, for the tooltip ("PostgreSQL"). */
  label: string;
}

const LABEL: Record<string, string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  redis: 'Redis',
  valkey: 'Valkey',
  mongodb: 'MongoDB',
  elasticsearch: 'Elasticsearch',
  meilisearch: 'Meilisearch',
  typesense: 'Typesense',
  opensearch: 'OpenSearch',
  nginx: 'nginx',
  node: 'Node.js',
  golang: 'Go',
  php: 'PHP',
  python: 'Python',
  rabbitmq: 'RabbitMQ',
  mailpit: 'Mailpit',
  minio: 'MinIO',
  rustfs: 'RustFS',
  httpd: 'Apache httpd',
  clickhouse: 'ClickHouse',
};

export function serviceLook(image: string): ServiceLook {
  const name = image.toLowerCase().replace(/@.*$/, '').replace(/:[^/]*$/, '').split('/').pop() ?? '';
  const key = ALIAS[name] ?? name;
  if (LOGO[key]) return { logo: LOGO[key], label: LABEL[key] ?? key };
  // Images that carry the name inside (bitnami-postgresql, my-redis-cache, api-node).
  const hit = Object.keys(LOGO).find((k) => k.length > 3 && name.includes(k)) ?? Object.keys(ALIAS).find((k) => k.length > 3 && name.includes(k));
  const k2 = hit ? (ALIAS[hit] ?? hit) : null;
  return k2 && LOGO[k2] ? { logo: LOGO[k2], label: LABEL[k2] ?? k2 } : { logo: null, label: 'Container' };
}
