import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  type BusinessServiceOptions,
  loadBusinessServiceConfig,
  loadLocalEnv,
} from '@lessonplus/config';
import { AppModule } from './app.module.js';
import { HttpExceptionFilter } from './presentation/http-exception.filter.js';

export interface ServiceBootstrapOptions extends BusinessServiceOptions {
  swaggerTitle: string;
}

function readConfig(options: ServiceBootstrapOptions) {
  try {
    return loadBusinessServiceConfig(process.env, options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

export async function bootstrap(options: ServiceBootstrapOptions): Promise<void> {
  loadLocalEnv();
  const config = readConfig(options);

  const app = await NestFactory.create(AppModule.register(config));
  app.enableShutdownHooks();
  app.useGlobalFilters(new HttpExceptionFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle(options.swaggerTitle)
    .setDescription(
      'Каркас сервиса. Бизнес-сценарии, диспетчер outbox и потребители событий на этом этапе не реализованы.',
    )
    .setVersion('0.1.0')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  await app.listen(config.port, config.host);
  Logger.log(`Слушает http://${config.host}:${config.port}`, options.serviceName);
}
