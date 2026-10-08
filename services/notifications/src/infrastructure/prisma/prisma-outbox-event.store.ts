import type { EventEnvelope } from '@lessonplus/contracts';
import { Prisma } from '../../generated/prisma/client.js';
import type { OutboxEventStore } from '../../application/ports.js';
import type { PrismaService } from './prisma.service.js';

export class PrismaOutboxEventStore implements OutboxEventStore {
  constructor(private readonly prisma: PrismaService) {}

  async save(event: EventEnvelope): Promise<void> {
    await this.prisma.client.outboxEvent.create({
      data: {
        id: event.event_id,
        eventType: event.event_type,
        schemaVersion: event.schema_version,
        payload: toJson(event.payload),
        createdAt: new Date(event.occurred_at),
        correlationId: event.correlation_id,
      },
    });
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  if (value === null) {
    return Prisma.JsonNull as unknown as Prisma.InputJsonValue;
  }

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
