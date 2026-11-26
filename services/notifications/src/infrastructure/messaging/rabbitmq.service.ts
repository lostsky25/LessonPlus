import { setTimeout as delay } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import type { MessageBrokerProbe } from '../../application/ports.js';
import type { SubscriptionActivationStore } from '../../application/subscription-activation.js';
import { sanitizeError } from '../../sanitize-error.js';
import { parseSubscriptionActivation, SUBSCRIPTION_ACTIVATED } from './subscription-activated.js';

const EXCHANGE = 'lessonplus.events';
const QUEUE = 'lessonplus.notifications.events';
const RETRY_DELAY_MS = 1000;

export class RabbitMqService implements MessageBrokerProbe {
  private readonly logger = new Logger(RabbitMqService.name);
  private connection: ChannelModel | undefined;
  private worker: Promise<void> | undefined;
  private ready = false;
  private stopping = false;

  constructor(
    private readonly url: string,
    private readonly activations: SubscriptionActivationStore,
  ) {}

  onModuleInit(): void {
    this.worker = this.run();
  }

  async ping(): Promise<void> {
    if (!this.ready) {
      throw new Error('Получатель SubscriptionActivated не подключён');
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    if (this.connection) {
      await this.closeConnection(this.connection);
    }
    await this.worker;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.consume();
      } catch (error) {
        if (!this.stopping) {
          this.logger.warn('RabbitMQ недоступен: ' + sanitizeError(error));
        }
      }
      if (!this.stopping) {
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  private async consume(): Promise<void> {
    const connection = await amqp.connect(this.url, { timeout: 3000 });
    this.connection = connection;
    let inFlight: Promise<void> | undefined;
    let disconnected = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const finish = () => {
      disconnected = true;
      this.ready = false;
      resolveClosed();
    };
    const onError = (error: unknown) => {
      this.logger.warn('Ошибка RabbitMQ: ' + sanitizeError(error));
      finish();
    };
    connection.on('error', onError);
    connection.once('close', finish);

    try {
      if (this.stopping) {
        return;
      }
      const channel = await connection.createChannel();
      channel.on('error', onError);
      channel.once('close', finish);
      await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
      await channel.assertQueue(QUEUE, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
      await channel.bindQueue(QUEUE, EXCHANGE, SUBSCRIPTION_ACTIVATED);
      await channel.prefetch(1);
      await channel.consume(
        QUEUE,
        (message) => {
          if (!message) {
            finish();
            return;
          }
          inFlight = this.handle(channel, message, () => !disconnected).catch(onError);
        },
        { noAck: false },
      );
      this.ready = !this.stopping && !disconnected;
      await closed;
    } finally {
      finish();
      await this.closeConnection(connection);
      await inFlight;
      this.connection = undefined;
    }
  }

  private async handle(
    channel: Channel,
    message: ConsumeMessage,
    isConnected: () => boolean,
  ): Promise<void> {
    const activation = parseSubscriptionActivation(message.content);
    if (!activation) {
      this.logger.warn('Некорректное сообщение SubscriptionActivated отклонено');
      channel.reject(message, false);
      return;
    }

    while (!this.stopping && isConnected()) {
      try {
        await this.activations.record(activation);
      } catch (error) {
        this.logger.warn('Не удалось сохранить поручение: ' + sanitizeError(error));
        await delay(RETRY_DELAY_MS);
        continue;
      }

      if (isConnected()) {
        channel.ack(message);
      }
      return;
    }
  }

  private async closeConnection(connection: ChannelModel): Promise<void> {
    try {
      await connection.close();
    } catch {
      // The broker may have closed the connection first.
    }
  }
}
