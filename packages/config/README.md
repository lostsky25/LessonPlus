# @lessonplus/config

Проверка переменных окружения при запуске. Пакет не зависит от NestJS.

Для бизнес-сервиса на хосте используется переменная вида `SUBSCRIPTIONS_DATABASE_URL` (хост `localhost`). В Docker Compose процесс получает `DATABASE_URL` с именем контейнера `postgres`. Если заданы обе, приоритет у `DATABASE_URL`.
