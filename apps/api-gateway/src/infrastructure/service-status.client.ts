import { Inject, Injectable, Logger } from '@nestjs/common';
import type { GatewayConfig } from '@lessonplus/config';
import { type ProbeStatus, type ServiceStatus, type SystemStatus } from '@lessonplus/contracts';
import { GATEWAY_CONFIG } from '../tokens.js';

const PROBE_TIMEOUT_MS = 5000;

@Injectable()
export class ServiceStatusClient {
  private readonly logger = new Logger(ServiceStatusClient.name);

  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {}

  async collect(): Promise<SystemStatus> {
    const services = await Promise.all(
      this.config.services.map((service) => this.inspect(service)),
    );
    return { services };
  }

  private async inspect(service: GatewayConfig['services'][number]): Promise<ServiceStatus> {
    const [live, ready] = await Promise.all([
      this.probe(service.url, '/health/live'),
      this.probe(service.url, '/health/ready'),
    ]);

    return {
      name: service.name as ServiceStatus['name'],
      live,
      ready,
    };
  }

  private async probe(baseUrl: string, path: string): Promise<ProbeStatus> {
    try {
      const response = await fetch(new URL(path, ensureTrailingSlash(baseUrl)), {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return response.ok ? 'up' : 'down';
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown';
      this.logger.warn(`Нет ответа от ${baseUrl}${path}: ${reason}`);
      return 'down';
    }
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}
