import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PanelState } from './types.js';
import { padockEnv } from './config.js';

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const subdomainPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface GatewayPublicStatus {
  enabled: boolean;
  configured: boolean;
  baseDomain?: string;
  publicPort: number;
  wildcard?: string;
  dnsTarget?: string;
  routes: number;
}

export class MinecraftGateway {
  readonly enabled = padockEnv('GATEWAY_ENABLED') === 'true';
  readonly baseDomain = normalizeBaseDomain(padockEnv('GATEWAY_DOMAIN'));
  readonly publicPort = Number(padockEnv('GATEWAY_PORT') ?? 25565);
  readonly backendHost = padockEnv('GATEWAY_BACKEND_HOST')?.trim() || '127.0.0.1';
  readonly configPath = path.resolve(padockEnv('GATEWAY_CONFIG') ?? './data/gateway/config.yml');
  readonly dnsTarget = padockEnv('GATEWAY_DNS_TARGET')?.trim() || undefined;

  constructor() {
    if (!Number.isInteger(this.publicPort) || this.publicPort < 1 || this.publicPort > 65535) {
      throw new Error('PADOCK_GATEWAY_PORT doit être un port TCP valide.');
    }
    if (this.enabled && !this.baseDomain) {
      throw new Error('PADOCK_GATEWAY_DOMAIN doit contenir un domaine valide lorsque la passerelle est activée.');
    }
  }

  status(state: PanelState): GatewayPublicStatus {
    return {
      enabled: this.enabled,
      configured: this.enabled && Boolean(this.baseDomain),
      baseDomain: this.baseDomain,
      publicPort: this.publicPort,
      wildcard: this.baseDomain ? `*.${this.baseDomain}` : undefined,
      dnsTarget: this.dnsTarget,
      routes: state.servers.filter((server) => server.domain).length,
    };
  }

  domainFor(subdomain: string) {
    if (!this.enabled || !this.baseDomain) throw Object.assign(new Error('La passerelle Minecraft n’est pas configurée.'), { statusCode: 409 });
    const normalized = subdomain.trim().toLowerCase();
    if (!subdomainPattern.test(normalized)) throw Object.assign(new Error('Le sous-domaine doit contenir uniquement des lettres minuscules, chiffres et tirets.'), { statusCode: 400 });
    return `${normalized}.${this.baseDomain}`;
  }

  subdomainFor(domain?: string) {
    if (!domain || !this.baseDomain || !domain.endsWith(`.${this.baseDomain}`)) return '';
    return domain.slice(0, -(this.baseDomain.length + 1));
  }

  async sync(state: PanelState) {
    if (!this.enabled) return;
    const routes = state.servers
      .filter((server): server is typeof server & { domain: string } => Boolean(server.domain))
      .map((server) => {
        const allocation = state.allocations.find((item) => item.id === server.allocationId);
        const backendHost = allocation?.ip && allocation.ip !== '0.0.0.0' ? allocation.ip : this.backendHost;
        return { host: server.domain, backend: `${formatHost(backendHost)}:${server.port}` };
      })
      .sort((left, right) => left.host.localeCompare(right.host));

    const lines = [
      '# Généré automatiquement par Padock. Ne pas modifier manuellement.',
      'config:',
      `  bind: ${yamlString(`0.0.0.0:${this.publicPort}`)}`,
      '  lite:',
      '    enabled: true',
    ];
    lines.push('    routes:');
    if (!routes.length) {
      // Gate valide au moins une route au démarrage. Le TLD .invalid est réservé
      // et ne peut jamais correspondre à un vrai domaine de joueur.
      lines.push('      - host: "padock-unconfigured.invalid"', '        backend: "127.0.0.1:9"');
    } else {
      for (const route of routes) lines.push(`      - host: ${yamlString(route.host)}`, `        backend: ${yamlString(route.backend)}`);
    }
    lines.push('');

    await mkdir(path.dirname(this.configPath), { recursive: true });
    const temporary = `${this.configPath}.${process.pid}.tmp`;
    await writeFile(temporary, lines.join('\n'), { mode: 0o644 });
    await rename(temporary, this.configPath);
  }
}

function normalizeBaseDomain(value?: string) {
  const normalized = value?.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  return normalized && domainPattern.test(normalized) ? normalized : undefined;
}

function formatHost(value: string) {
  return value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
}

function yamlString(value: string) {
  return JSON.stringify(value);
}
