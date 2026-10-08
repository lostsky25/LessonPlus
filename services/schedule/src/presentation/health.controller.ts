import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CheckReadiness, type ReadinessReport } from '../application/check-readiness.js';

class LiveDto {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';
}

class ChecksDto {
  @ApiProperty({ enum: ['up', 'down'] })
  postgres!: 'up' | 'down';

  @ApiProperty({ enum: ['up', 'down'] })
  rabbitmq!: 'up' | 'down';
}

class ReadinessDto {
  @ApiProperty({ enum: ['ok', 'unavailable'] })
  status!: 'ok' | 'unavailable';

  @ApiProperty({ type: ChecksDto })
  checks!: ChecksDto;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: CheckReadiness) {}

  @Get('live')
  @ApiOperation({ summary: 'Процесс запущен' })
  @ApiOkResponse({ type: LiveDto })
  live(): LiveDto {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'PostgreSQL и RabbitMQ доступны' })
  @ApiOkResponse({ type: ReadinessDto })
  @ApiResponse({ status: 503, type: ReadinessDto })
  async ready(): Promise<ReadinessReport> {
    const report = await this.readiness.execute();
    if (report.status !== 'ok') {
      throw new HttpException(report, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return report;
  }
}
