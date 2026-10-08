import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { loadGatewayConfig, loadLocalEnv } from '@lessonplus/config';
import { AppModule } from './app.module.js';
import { HttpExceptionFilter } from './presentation/http-exception.filter.js';

function readConfig() {
  try {
    return loadGatewayConfig(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function bootstrap(): Promise<void> {
  loadLocalEnv();
  const config = readConfig();

  const app = await NestFactory.create(AppModule.register(config));
  app.enableShutdownHooks();
  app.enableCors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  });
  app.useGlobalFilters(new HttpExceptionFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('API gateway')
    .setDescription(
      'Вход для интерфейса. Бизнес-правил нет, прямой доступ к базам сервисов не используется.',
    )
    .setVersion('0.1.0')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  await app.listen(config.port, config.host);
  Logger.log(`Слушает http://${config.host}:${config.port}`, 'api-gateway');
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
