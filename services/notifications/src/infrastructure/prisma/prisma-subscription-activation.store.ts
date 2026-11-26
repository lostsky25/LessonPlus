import { randomUUID } from 'node:crypto';
import type {
  SubscriptionActivation,
  SubscriptionActivationStore,
} from '../../application/subscription-activation.js';
import type { PrismaService } from './prisma.service.js';

export class PrismaSubscriptionActivationStore implements SubscriptionActivationStore {
  constructor(private readonly prisma: PrismaService) {}

  async record({ eventId, studentId, subscriptionId }: SubscriptionActivation): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      const now = new Date();
      // A concurrent insert waits for the transaction owning this event ID.
      const { count } = await tx.processedEvent.createMany({
        data: { id: eventId, processedAt: now },
        skipDuplicates: true,
      });
      if (count === 0) {
        return;
      }

      await tx.notification.create({
        data: {
          id: randomUUID(),
          studentId,
          subjectType: 'subscription',
          subjectId: subscriptionId,
          sourceEventId: eventId,
          status: 'pending',
          channel: 'imitation',
          recordedAt: now,
        },
      });
    });
  }
}
