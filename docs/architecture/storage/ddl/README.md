# Проектный DDL

Файлы в этом каталоге — архитектурная модель шага 6.3, не миграции Prisma. Обзор пакета хранения — [storage-architecture.md](../../storage-architecture.md).

- Не выполнять на рабочей базе.
- Не копировать автоматически в `services/*/prisma/migrations`.
- Таблицы `outbox_events` и `processed_events` уже созданы миграцией `20261007120000_init`; здесь их `CREATE` нет.

Колонки и ограничения должны совпадать с [03-data-model.md](../03-data-model.md). ER в `docs/architecture/diagrams/er-*.mmd` показывают сокращённый набор тех же полей и связей, без вымышленных имён. Вторичные индексы чтения — [04-queries-and-indexes.md](../04-queries-and-indexes.md); в эти файлы они не копируются.
