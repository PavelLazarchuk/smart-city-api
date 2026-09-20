import { Controller, Get, HttpException, HttpStatus, Inject, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
    HealthCheck,
    HealthCheckService,
    type HealthCheckResult,
    type HealthIndicatorResult,
    MongooseHealthIndicator,
} from '@nestjs/terminus';
import { type Request } from 'express';
import { PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../../common/config/app-config';
import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ROLES, Roles } from '../../common/decorators/roles.decorator';
import { ApiError } from '../../common/http/api-error';
import { MailService } from '../../integrations/mail/mail.service';
import { STORAGE_PROVIDER, type StorageProvider } from '../../integrations/storage/storage.provider';
import { type JobStatus, JobLockService } from '../../jobs/job-lock.service';

export interface BuildInfo {
    version: string;
    commit: string | null;
    env: string;
    node: string;
    started_at: string;
    uptime_seconds: number;
}

const startedAt = new Date();

@ApiTags('health')
@Controller('health')
export class HealthController {
    constructor(
        private readonly health: HealthCheckService,
        private readonly mongoose: MongooseHealthIndicator,
        @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
        private readonly mail: MailService,
        private readonly jobs: JobLockService,
        private readonly config: AppConfig,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(HealthController.name);
    }

    @Get('live')
    @Public()
    @HealthCheck()
    live(): Promise<HealthCheckResult> {
        return this.health.check([]);
    }

    /** What the orchestrator polls: only the dependency the process cannot serve a request without. */
    @Get('ready')
    @Public()
    @HealthCheck()
    ready(): Promise<HealthCheckResult> {
        return this.health.check([() => this.mongoose.pingCheck('mongodb', { timeout: 3000 })]);
    }

    /**
     * Kept apart from `ready`: an SMTP outage degrades notifications but must not drop the instance from the
     * load balancer. The cause names hosts and buckets, so it goes to the log and to super-admins only.
     */
    @Get('deps')
    @Public()
    @HealthCheck()
    async deps(@Req() request: Request & { user?: AuthUser }): Promise<HealthCheckResult> {
        const reveal = request.user?.role === ROLES.SUPER_ADMIN;
        try {
            return await this.health.check([
                () => this.mongoose.pingCheck('mongodb', { timeout: 3000 }),
                () => this.probe('storage', reveal, () => this.storage.check()),
                () => this.probe('mail', reveal, () => this.mail.check()),
            ]);
        } catch (error) {
            throw this.unavailable(error);
        }
    }

    /** Super-admin only: it carries the recorded failure message, which names hosts like `deps` does. */
    @Get('jobs')
    @ApiBearerAuth()
    @Roles(ROLES.SUPER_ADMIN)
    async jobsStatus(): Promise<{ data: JobStatus[] }> {
        return { data: await this.jobs.statuses() };
    }

    @Get('info')
    @Public()
    info(): { data: BuildInfo } {
        return {
            data: {
                version: this.config.build.version,
                commit: this.config.build.sha ?? null,
                env: this.config.env,
                node: process.version,
                started_at: startedAt.toISOString(),
                uptime_seconds: Math.round(process.uptime()),
            },
        };
    }

    /** Terminus throws a body the global filter would replace, so failures are re-raised as error details. */
    private unavailable(error: unknown): ApiError {
        const body = error instanceof HttpException ? error.getResponse() : undefined;
        const down =
            typeof body === 'object' && body && 'error' in body
                ? (body.error as Record<string, { status?: string; message?: string }>)
                : {};

        return new ApiError(
            HttpStatus.SERVICE_UNAVAILABLE,
            'DEPENDENCY_UNAVAILABLE',
            Object.entries(down).map(([name, detail]) => ({
                path: name,
                message: detail.message ?? 'down',
            })),
        );
    }

    private async probe(
        key: string,
        reveal: boolean,
        run: () => Promise<void>,
    ): Promise<HealthIndicatorResult> {
        try {
            await run();

            return { [key]: { status: 'up' } };
        } catch (error) {
            this.logger.error({ err: error, dependency: key }, 'dependency probe failed');

            return { [key]: { status: 'down', message: reveal ? (error as Error).message : 'down' } };
        }
    }
}
