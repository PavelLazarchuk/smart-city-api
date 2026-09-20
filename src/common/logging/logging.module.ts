import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { type IncomingMessage, type ServerResponse } from 'node:http';

import { AppConfig } from '../config/app-config';
import { resolveRequestId } from '../context/request-id';

@Module({
    imports: [
        LoggerModule.forRootAsync({
            inject: [AppConfig],
            useFactory: (config: AppConfig) => ({
                pinoHttp: {
                    level: config.log.level,
                    transport:
                        config.isProduction || config.isTest
                            ? undefined
                            : {
                                  target: 'pino-pretty',
                                  options: {
                                      colorize: true,
                                      singleLine: true,
                                      translateTime: 'SYS:standard',
                                  },
                              },
                    genReqId: (req: IncomingMessage) => resolveRequestId(req),
                    customProps: (req: IncomingMessage & { user?: { id?: string } }) => ({
                        request_id: (req as { id?: string }).id,
                        user_id: req.user?.id,
                    }),
                    customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
                        if (err || res.statusCode >= 500) return 'error';

                        if (res.statusCode >= 400) return 'warn';

                        return 'info';
                    },
                    customSuccessMessage: (req: IncomingMessage, res: ServerResponse) =>
                        `${req.method ?? ''} ${req.url ?? ''} ${res.statusCode}`,
                    customErrorMessage: (req: IncomingMessage, res: ServerResponse) =>
                        `${req.method ?? ''} ${req.url ?? ''} ${res.statusCode}`,
                    autoLogging: !config.isTest,
                    serializers: {
                        req: (req: { id: string; method: string; url: string; remoteAddress?: string }) => ({
                            id: req.id,
                            method: req.method,
                            url: req.url,
                            remote_address: req.remoteAddress,
                        }),
                        res: (res: { statusCode: number }) => ({ status: res.statusCode }),
                    },
                    redact: {
                        paths: [
                            'req.headers.authorization',
                            'req.headers.cookie',
                            '*.password',
                            '*.new_password',
                            '*.new_password_confirmation',
                            '*.current_password',
                            '*.token',
                            '*.access_token',
                            '*.refresh_token',
                            '*.code',
                            '*.phone',
                            '*.*.phone',
                            '*.*.*.phone',
                            '*.user_phone',
                            '*.*.user_phone',
                            '*.*.*.user_phone',
                            'phone',
                            'password',
                            'token',
                        ],
                        censor: '[redacted]',
                    },
                },
            }),
        }),
    ],
})
export class LoggingModule {}
