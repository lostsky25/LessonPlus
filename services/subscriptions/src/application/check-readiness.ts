import type { DatabaseProbe, MessageBrokerProbe } from './ports.js';

export type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  checks: {
    postgres: DependencyStatus;
    rabbitmq: DependencyStatus;
  };
}

export class CheckReadiness {
  constructor(
    private readonly database: DatabaseProbe,
    private readonly broker: MessageBrokerProbe,
  ) {}

  async execute(): Promise<ReadinessReport> {
    const [postgres, rabbitmq] = await Promise.all([
      this.probe(this.database),
      this.probe(this.broker),
    ]);
    const status = postgres === 'up' && rabbitmq === 'up' ? 'ok' : 'unavailable';
    return { status, checks: { postgres, rabbitmq } };
  }

  private async probe(dependency: { ping(): Promise<void> }): Promise<DependencyStatus> {
    try {
      await dependency.ping();
      return 'up';
    } catch {
      return 'down';
    }
  }
}
