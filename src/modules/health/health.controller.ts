import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
    HealthCheck,
    HealthCheckService,
    type HealthCheckResult,
    MongooseHealthIndicator,
} from '@nestjs/terminus';

import { Public } from '../../common/decorators/public.decorator';

@ApiTags('health')
@Controller('health')
export class HealthController {
    constructor(
        private readonly health: HealthCheckService,
        private readonly mongoose: MongooseHealthIndicator,
    ) {}

    @Get('live')
    @Public()
    @HealthCheck()
    live(): Promise<HealthCheckResult> {
        return this.health.check([]);
    }

    @Get('ready')
    @Public()
    @HealthCheck()
    ready(): Promise<HealthCheckResult> {
        return this.health.check([() => this.mongoose.pingCheck('mongodb', { timeout: 3000 })]);
    }
}
