import type { EventEnvelope } from '@lessonplus/contracts';

export interface DatabaseProbe {
  ping(): Promise<void>;
}

export interface MessageBrokerProbe {
  ping(): Promise<void>;
}

/** Запись события в локальную таблицу outbox. Публикация в брокер — следующий этап. */
export interface OutboxEventStore {
  save(event: EventEnvelope): Promise<void>;
}

/** Учёт уже обработанных входящих событий. Повторная обработка сценариев — следующий этап. */
export interface ProcessedEventStore {
  isProcessed(eventId: string): Promise<boolean>;
  markProcessed(eventId: string): Promise<void>;
}
