# Масштабирование хранения

Шаг 6.7 архитектуры хранения. Топология — [02-storage-and-isolation.md](02-storage-and-isolation.md). Владение — [01-data-ownership.md](01-data-ownership.md). Модель — [03-data-model.md](03-data-model.md). Пять показательных SELECT — [04-queries-and-indexes.md](04-queries-and-indexes.md). Конкуренция и outbox — [05-transactions-and-consistency.md](05-transactions-and-consistency.md). Резервирование — [06-backup-and-recovery.md](06-backup-and-recovery.md).

Ссылки PostgreSQL 17: [Partitioning limitations](https://www.postgresql.org/docs/17/ddl-partitioning.html), [Warm Standby](https://www.postgresql.org/docs/17/warm-standby.html), [Hot Standby](https://www.postgresql.org/docs/17/hot-standby.html).

Исходный масштаб — **учебный прототип одного центра**. Один Compose-сервис `postgres:17.11`, одна база, пять схем. Фактические объёмы строк и скорость запросов **не измерены**. Числа пользователей / QPS ниже — **допущения**, не измерения. Реплики, pooler, кластер и шарды **не** развёрнуты и этим шагом не объявляются выполненными. SQL/DDL/cleanup в шаге не выполнялись.

---

## 1. Достаточность одного экземпляра PostgreSQL

**Сейчас достаточно одного экземпляра.** Причины:

1. Нагрузка боевого контура и SLA не заданы; каркас ещё без CRUD, outbox-dispatcher и потребителей фактов ([AGENTS.md](../../../AGENTS.md)).
2. Топология А (6.2): логическая изоляция пяти схем + роли `*_user` без `SUPERUSER` сохраняет **границы сервисов** (нет чужого SQL) без пяти кластеров. Согласование между владельцами — HTTP/события; **одна PG не означает единую TX** между сервисами (сага уже межсервисная).
3. Согласованный снимок пяти схем для переноса и backup (6.6) проще на одной базе.
4. Пять SELECT 6.4 рассчитаны на keyset + индексы; планы и время **не измерены**.

**Допущения (не измерения):** один учебный центр; порядок сотен учеников и занятий в сезоне; пик единиц–десятков запросов в секунду на стенде. При выходе — сначала наблюдение (§2), не шарды.

**SPOF:** один primary остаётся единой точкой отказа (CPU/диск/процесс). План backup (6.6) **восстанавливает данные** и поддерживает drill RPO/RTO-ориентиры; он **не** обеспечивает высокую доступность (HA) и не устраняет простой, пока restore/failover не завершены. Реплика (§3) — отдельный будущий механизм; **не** заменяет независимую backup-копию: логическая ошибка или DELETE реплицируются на standby.

---

## 2. Последовательность развития

Порядок: **не** начинать с реплик/шардов без измерений.

| Этап | Действия | Показатели для следующего шага |
| ---- | -------- | ------------------------------ |
| **A. Наблюдение** | См. §2.1 | Устойчивые отклонения от согласованных SLO (когда появятся) / приближение к лимитам соединений и ресурсов |
| **B. Индексы и запросы** | Проектные индексы 6.4 после появления таблиц; EXPLAIN/BUFFERS пяти SELECT на **репрезентативных** данных (в 6.7 **не** выполнялось) | Улучшение p95/p99 целевых запросов без лишнего удорожания записи; seq scan не «враг» (§2.1) |
| **C. Пулы** | Измерить defaults драйвера (§6); бюджет соединений; уменьшить pool per instance или (кандидат) pooler после проверки совместимости | Отказы connect / pool wait в норме SLO |
| **D. Ресурсы узла** | CPU / RAM / IOPS после A–C | Утилизация упирается в потолок узла |
| **E. Реплика / пересмотр** | Только при основании (§3–§4) | Таблица §7 |

### 2.1. Наблюдение (без объявления текущей производительности)

Seq scan на малой таблице или при низкой селективности может быть **правильным** планом; цель — не «убрать seq scan», а оценить пять реальных запросов и планы на репрезентативных данных.

Смотреть (когда мониторинг включат): p95/p99 latency; lock waits / deadlocks; pool wait / active / idle / timeouts; CPU/RAM/IO; рост таблиц и autovacuum; у outbox и очередей — не только count, но **возраст старейшего** необработанного, скорость обработки, ошибки. Решения привязывать к **согласованным SLO и измерениям**, не считать текущую производительность подтверждённой этим документом.

---

## 3. Роли реплик: доступность и чтение

Реплика — **проект**. Сейчас **всё чтение и запись — primary**.

| Роль | Назначение | Ограничение |
| ---- | ---------- | ----------- |
| Standby / hot standby | Кандидат на promote при отказе primary ([warm](https://www.postgresql.org/docs/17/warm-standby.html) / [hot standby](https://www.postgresql.org/docs/17/hot-standby.html)) | Не замена независимого backup; async lag |
| Чтение | Только SELECT с **явным** контрактом допустимой устарелости | Lag monitoring + предел + fallback на primary |

**Чтение с реплики — только после:** контракта stale, мониторинга lag и порога, fallback. До этого — primary.

**Всегда primary (даже GET по UUID):** read-your-writes после мутации; исходы HTTP idempotency; состояние transfer / recovery / claim / `binding_knowledge`; списание и вместимость; любые данные для решения о эффекте.

**Могут когда-либо уйти на replica** (после контракта): чисто обзорные списки без решения о месте/праве (например «расписание на неделю» без accept).

**Outbox (исправление формулировки):** в **одной TX** — бизнес-изменение + `INSERT outbox_events`. Сетевой publish — **после** commit; publisher confirm и установка `published_at` — отдельные шаги. Атомарности «TX Postgres ↔ брокер» нет.

**Будущий async failover (кратко):** возможны lag и потеря уже committed на primary TX, не дошедших до standby; обязательны остановка/fencing старого primary и воркеров против split-brain; переподключение клиентов; неопределённые результаты TX. При потере commit — согласование сообщений/ключей по **6.6 до любого replay**. Sync replication — отдельный tradeoff latency/availability, **не** обещание автоматического RPO=0.

---

## 4. Шардирование и партиционирование

**Шардирование сейчас не требуется** и не принимается как «ослабить инварианты 05». Допустимый рост — только если сохраняются: атомарность business+outbox и processed+effect у владельца; локальные UNIQUE/CHECK/locks 05. Иначе шарды **не** принимать.

Причины отказа сейчас: один центр; нет измерений после §2; `student_id` как shard key развёл бы учеников одного `lesson` и сломал общий счётчик вместимости; `school_id` в модели **не** задан как shard key (только гипотеза). Межсервисная saga уже есть: схемы разделены, единой TX между владельцами нет.

**Партиционирование журналов по времени — не «просто добавить».** В PostgreSQL 17 UNIQUE/PK родительской partitioned table должны включать все partition key ([limitations](https://www.postgresql.org/docs/17/ddl-partitioning.html)). Для текущих ключей:

| Объект | Глобальная идентичность сегодня | Проблема range-by-time |
| ------ | ------------------------------- | ---------------------- |
| `processed_events(id)` | PK = `event_id` | PK должен включать partition key → иначе нет прежней глобальной дедупликации одним UNIQUE |
| `outbox_events(id)` | PK event id | то же |
| consume/restore UNIQUE | `(right_id, booking_id)` / `consumed_operation_id` | нужны все partition keys в UNIQUE или иной дизайн |
| attempts `(notification_id, attempt_no)` | UNIQUE пары | то же |

Нужен отдельный дизайн глобальной идентичности/дедупликации, FK/lookup/retention и пересмотр пяти запросов/индексов. `DETACH`/`DROP` старой партиции выводит данные из обычного online-доступа и **не** разрешён одним возрастом строки.

**Сейчас:** оставить **обычные** (неpartitioned) таблицы. Partitioning — кандидат только после доказанного дизайна выше; не замена схемам сервисов и не шаг «по умолчанию при росте».

---

## 5. Рост журналов и запрет опасной очистки

| Объект | Роль для correctness | Авто-delete по возрасту |
| ------ | -------------------- | ----------------------- |
| `outbox_events` | Republish; retained включает уже `published` при broker-loss (6.6); `published_at` **не** доказывает приём всеми | **Нет**, пока не доказан полный горизонт replay/restore |
| `processed_events` | Идемпотентность получателя | **Нет** раньше всех допустимых повторов (не только 5 TTL очереди: DLQ, manual redrive, отложенный HTTP, recovery, restore старых backup) |
| `right_operations` consume/restore + корреляции | UNIQUE и сверка restore | **Нет** как «после аудита» |
| Lifetime `right_reservations.transfer_id` UNIQUE | Инвариант «один резерв на transfer» | Строки истории **не** чистить ради места |
| `compensated_right_releases` | Terminal проекция seat release | **Не** удалять |
| `canceled_lessons` | Блок consume | **Не** удалять по возрасту без процедуры |
| Внутренние HTTP idempotency / sticky outbound steps+inputs | Recovery 05 | **Не** auto-delete; публичные ≥72h — минимум + доказуемый terminal + cleanup advisory→row lock (05) |
| Notifications UNIQUE `(source_event_id, student_id, channel)`, `next_attempt_no`, UNIQUE `(notification_id, attempt_no)` | Дедуп поручений и попыток | **Не** обходить чисткой «после аудита» |

TTL пяти retry-ступеней брокера **не** верхний горизонт хранения correctness-строк.

**Холодный архив** сам по себе **не** участвует в online UNIQUE/`processed` lookup. Перед допустимым replay нужна сохранённая **online**-защита или отдельная **проверенная** процедура восстановления защиты — не обещание «архивировали и можно повторить». Числовые сроки хранения **не** выдумывать, пока горизонт не доказан.

Произвольный `TRUNCATE`/delete «для места» — запрещён.

---

## 6. Несколько экземпляров сервисов и соединения

Факт кода: `PrismaClient` + `@prisma/adapter-pg` / `PrismaPg` (`services/*/src/infrastructure/prisma/prisma.service.ts`). Параметр `max` пула **явно не задан** — это **не** «бесконечный pool»; до бюджета нужно **измерить/проверить defaults драйвера** `pg`. Произвольное число в документ не выдавать за факт.

**Бюджет (проект):**  
`Σ(instances × pools_per_process × pool_max) + отдельные workers + migrations + admin + monitoring`  
должен помещаться в доступный лимит Postgres **с reserved slots и запасом**, учитывая rollout surge и reconnect bursts. **Gateway и web DB connections не получают.**

Увеличение `max_connections` без учёта RAM/нагрузки — не лечение.

**PgBouncer** — только **кандидат** после проверки совместимости с версией Prisma/adapter, prepared statements, `search_path`/session state и **transaction** advisory locks (05). Готовой совместимости не предполагать.

**Конкуренция** — по точному 05: claim `owner`/`generation`/`lease`; после `FOR UPDATE` transfer проверка на **`clock_timestamp()`**; fencing всех локальных записей в одной TX; поздний HTTP безопасен только sticky immutable inputs + owner predicates/idempotency. Hold: TTL **не** −1 при unknown/committed.

**Dispatcher:** нет «магического idempotent publish». Возможны дубли при crash после broker confirm до записи `published_at`; нужны координация/claim publisher и у потребителей `processed`+effect. N слепых publisher без координации — недопустимы.

Пока dispatcher/consumers не реализованы, масштабирование «для нагрузки» преждевременно.

---

## 7. Сводка: сейчас — причина — сигнал пересмотра

| Решение сейчас | Причина | Сигнал для пересмотра |
| -------------- | ------- | --------------------- |
| Один Postgres; принять SPOF | Учебный прототип; backup = данные, не HA | Измеренный потолок узла; продуктовый HA; drill failover+fencing+6.6 |
| Независимый backup обязателен; реплика ≠ backup | Ошибки реплицируются на standby | Появление standby не отменяет 6.6 |
| Всё чтение/запись primary | Нет контракта stale/lag; RYW, idempotency, transfer/claim | Контракт + lag SLO + fallback; hot-path всё равно primary |
| Outbox: TX = бизнес+INSERT; publish после commit | Нет атомарности с брокером | — (инвариант сохранять) |
| Обычные таблицы; partitioning не внедрять | UNIQUE/PK + partition key (PG17); нет дизайна глобальной дедуп | Доказанный дизайн ключей/retention/запросов |
| Шарды не принимать, если ломают 05 | Атомарность owner TX и locks | Модель, сохраняющая business+outbox / processed+effect |
| Нет auto-delete correctness-строк по возрасту | Горизонт replay/DLQ/recovery/restore не доказан | Доказанный lifecycle + online защита или процедура |
| Retained outbox вкл. published при broker-loss | 6.6; `published_at` ≠ доставка всем | — |
| Не масштабировать инстансы без бюджета pool | Defaults `pg` неизвестны как факт; gateway без DB | Измеренный pool_max; запас к `max_connections` |
| PgBouncer не включён | Совместимость Prisma/advisory не проверена | Успешная проверка кандидатом |
| Наблюдение → индексы → пулы → CPU | Производительность не подтверждена | SLO + p95/p99 + возраст outbox + EXPLAIN на данных |

Согласование с 6.5–6.6: авторитетные эффекты и списание — primary; backup независим; масштабирование не отменяет reconciliation и запрет слепой компенсации.

---

## 8. Навигация

- [06-backup-and-recovery.md](06-backup-and-recovery.md), [05-transactions-and-consistency.md](05-transactions-and-consistency.md), [04-queries-and-indexes.md](04-queries-and-indexes.md)
- [02-storage-and-isolation.md](02-storage-and-isolation.md), [architecture.md](../../architecture.md)
