# @lessonplus/contracts

Внешние контракты монорепозитория: конверт события, каталог имён событий и DTO статуса системы для интерфейса.

Доменные модели сервисов сюда не переносятся. Поля `payload` в TypeScript остаются `unknown`. JSON Schema и примеры 20 фактов — в [events/README.md](events/README.md). Проектируемые HTTP-операции описаны в [openapi/README.md](openapi/README.md) и контроллеров не добавляют.
