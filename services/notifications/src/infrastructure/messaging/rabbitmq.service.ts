import { Logger } from '@nestjs/common';
import amqp, { type ChannelModel } from 'amqplib';
import type { MessageBrokerProbe } from '../../application/ports.js';
import { sanitizeError } from '../../sanitize-error.js';

const CONNECT_TIMEOUT_MS = 3000;

export class RabbitMqService implements MessageBrokerProbe {
  private readonly logger = new Logger(RabbitMqService.name);
  private connection: ChannelModel | null = null;

  constructor(private readonly url: string) {}

  async ping(): Promise<void> {
    try {
      const connection = await this.getConnection();
      const channel = await connection.createChannel();
      await channel.close();
    } catch (error) {
      this.logger.error(`RabbitMQ недоступен: ${sanitizeError(error)}`);
      await this.reset();
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.reset();
  }

  private async getConnection(): Promise<ChannelModel> {
    if (this.connection) {
      return this.connection;
    }

    this.connection = await connectWithTimeout(this.url);
    return this.connection;
  }

  private async reset(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (!connection) {
      return;
    }

    try {
      await connection.close();
    } catch {
      // Соединение уже закрыто брокером.
    }
  }
}

async function connectWithTimeout(url: string): Promise<ChannelModel> {
  const pending = amqp.connect(url);
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('RabbitMQ connection timeout')),
          CONNECT_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    void pending.then((connection) => connection.close()).catch(() => undefined);
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
