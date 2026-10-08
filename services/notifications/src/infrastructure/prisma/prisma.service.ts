import { Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import type { BusinessServiceConfig } from '@lessonplus/config';
import { PrismaClient } from '../../generated/prisma/client.js';
import type { DatabaseProbe } from '../../application/ports.js';
import { sanitizeError } from '../../sanitize-error.js';

export class PrismaService implements DatabaseProbe {
  private readonly logger = new Logger(PrismaService.name);
  readonly client: PrismaClient;

  constructor(config: BusinessServiceConfig) {
    const adapter = new PrismaPg(
      {
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 3000,
        options: `-c search_path=${config.schema}`,
      },
      { schema: config.schema },
    );
    this.client = new PrismaClient({ adapter });
  }

  async ping(): Promise<void> {
    try {
      await this.client.$queryRaw`SELECT 1`;
    } catch (error) {
      this.logger.error(`PostgreSQL недоступен: ${sanitizeError(error)}`);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
