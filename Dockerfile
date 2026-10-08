FROM node:24.20.0-bookworm-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.34.5 --activate

WORKDIR /app
COPY . .
# Значение нужно только чтобы prisma generate прочитал prisma.config.ts.
# При запуске контейнера Compose подставляет рабочий DATABASE_URL.
ENV DATABASE_URL=postgresql://placeholder:placeholder@127.0.0.1:5432/lessonplus?sslmode=disable
RUN pnpm install --frozen-lockfile && pnpm build

ENV NODE_ENV=production
EXPOSE 3000
