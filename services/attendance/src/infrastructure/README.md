# Infrastructure

Адаптеры портов: Prisma Client с драйвером `pg` через `@prisma/adapter-pg` и подключение к RabbitMQ.

Репозитории записывают строку в `outbox_events` и отмечают идентификатор в `processed_events`. Диспетчер outbox, потребители бизнес-событий и повторные попытки на этом этапе не запускаются.
