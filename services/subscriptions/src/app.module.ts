import { type DynamicModule, Module } from '@nestjs/common';
import type { BusinessServiceConfig } from '@lessonplus/config';
import { CheckReadiness } from './application/check-readiness.js';
import type { DatabaseProbe, MessageBrokerProbe } from './application/ports.js';
import {
  DATABASE_PROBE,
  MESSAGE_BROKER_PROBE,
  OUTBOX_EVENT_STORE,
  PROCESSED_EVENT_STORE,
  SERVICE_CONFIG,
} from './application/tokens.js';
import { RabbitMqService } from './infrastructure/messaging/rabbitmq.service.js';
import { PrismaOutboxEventStore } from './infrastructure/prisma/prisma-outbox-event.store.js';
import { PrismaProcessedEventStore } from './infrastructure/prisma/prisma-processed-event.store.js';
import { PrismaService } from './infrastructure/prisma/prisma.service.js';
import { HealthController } from './presentation/health.controller.js';

@Module({})
export class AppModule {
  static register(config: BusinessServiceConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [
        { provide: SERVICE_CONFIG, useValue: config },
        {
          provide: PrismaService,
          useFactory: (serviceConfig: BusinessServiceConfig) => new PrismaService(serviceConfig),
          inject: [SERVICE_CONFIG],
        },
        {
          provide: RabbitMqService,
          useFactory: (serviceConfig: BusinessServiceConfig) =>
            new RabbitMqService(serviceConfig.rabbitMqUrl),
          inject: [SERVICE_CONFIG],
        },
        { provide: DATABASE_PROBE, useExisting: PrismaService },
        { provide: MESSAGE_BROKER_PROBE, useExisting: RabbitMqService },
        {
          provide: CheckReadiness,
          useFactory: (database: DatabaseProbe, broker: MessageBrokerProbe) =>
            new CheckReadiness(database, broker),
          inject: [DATABASE_PROBE, MESSAGE_BROKER_PROBE],
        },
        {
          provide: OUTBOX_EVENT_STORE,
          useFactory: (prisma: PrismaService) => new PrismaOutboxEventStore(prisma),
          inject: [PrismaService],
        },
        {
          provide: PROCESSED_EVENT_STORE,
          useFactory: (prisma: PrismaService) => new PrismaProcessedEventStore(prisma),
          inject: [PrismaService],
        },
      ],
    };
  }
}
