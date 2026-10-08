import type { ProcessedEventStore } from '../../application/ports.js';
import type { PrismaService } from './prisma.service.js';

export class PrismaProcessedEventStore implements ProcessedEventStore {
  constructor(private readonly prisma: PrismaService) {}

  async isProcessed(eventId: string): Promise<boolean> {
    const found = await this.prisma.client.processedEvent.findUnique({
      where: { id: eventId },
    });
    return found !== null;
  }

  async markProcessed(eventId: string): Promise<void> {
    await this.prisma.client.processedEvent.create({
      data: {
        id: eventId,
        processedAt: new Date(),
      },
    });
  }
}
