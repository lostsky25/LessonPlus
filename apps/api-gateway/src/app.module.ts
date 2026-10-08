import { type DynamicModule, Module } from '@nestjs/common';
import type { GatewayConfig } from '@lessonplus/config';
import { ServiceStatusClient } from './infrastructure/service-status.client.js';
import { HealthController } from './presentation/health.controller.js';
import { SystemStatusController } from './presentation/system-status.controller.js';
import { GATEWAY_CONFIG } from './tokens.js';

@Module({})
export class AppModule {
  static register(config: GatewayConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, SystemStatusController],
      providers: [{ provide: GATEWAY_CONFIG, useValue: config }, ServiceStatusClient],
    };
  }
}
