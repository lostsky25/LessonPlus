import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { serviceNames, type SystemStatus } from '@lessonplus/contracts';
import { ServiceStatusClient } from '../infrastructure/service-status.client.js';

class ServiceStatusDto {
  @ApiProperty({ enum: serviceNames })
  name!: string;

  @ApiProperty({ enum: ['up', 'down'] })
  live!: 'up' | 'down';

  @ApiProperty({ enum: ['up', 'down'] })
  ready!: 'up' | 'down';
}

class SystemStatusDto {
  @ApiProperty({ type: [ServiceStatusDto] })
  services!: ServiceStatusDto[];
}

@ApiTags('system')
@Controller('api/system')
export class SystemStatusController {
  constructor(private readonly statuses: ServiceStatusClient) {}

  @Get('status')
  @ApiOperation({ summary: 'Фактические статусы пяти бизнес-сервисов' })
  @ApiOkResponse({ type: SystemStatusDto })
  getStatus(): Promise<SystemStatus> {
    return this.statuses.collect();
  }
}
