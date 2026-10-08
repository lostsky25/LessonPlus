import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';

class LiveDto {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get('live')
  @ApiOperation({ summary: 'Процесс gateway запущен' })
  @ApiOkResponse({ type: LiveDto })
  live(): LiveDto {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Конфигурация gateway загружена',
    description:
      'Gateway не подключается к PostgreSQL и RabbitMQ. Статусы бизнес-сервисов отдаёт GET /api/system/status.',
  })
  @ApiOkResponse({ type: LiveDto })
  ready(): LiveDto {
    return { status: 'ok' };
  }
}
