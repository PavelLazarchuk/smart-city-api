import { type INestApplication } from '@nestjs/common';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { Logger } from 'nestjs-pino';
import { resolve } from 'node:path';

import { AppConfig } from './common/config/app-config';

/** Everything `main.ts` and the e2e harness must share, so the two can never drift apart. */
export function configureApp(app: INestApplication): INestApplication {
    const config = app.get(AppConfig);
    const express = app as NestExpressApplication;

    app.useLogger(app.get(Logger));
    app.setGlobalPrefix(config.http.prefix);
    app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
    app.use(compression());
    app.enableCors({
        origin: config.http.corsOrigins.length > 0 ? config.http.corsOrigins : false,
        credentials: true,
        exposedHeaders: ['X-Request-Id', 'Location'],
    });
    express.useBodyParser('json', { limit: config.http.bodyLimit });
    express.useBodyParser('urlencoded', { limit: config.http.bodyLimit, extended: true });

    if (config.http.trustProxy) express.set('trust proxy', 1);

    if (config.storage.provider === 'local') {
        express.useStaticAssets(resolve(config.storage.local.dir), { prefix: '/uploads/', index: false });
    }

    app.enableShutdownHooks();

    if (config.http.swaggerEnabled) {
        const document = SwaggerModule.createDocument(
            app,
            new DocumentBuilder()
                .setTitle('Smart City API')
                .setDescription('REST API for the Smart City platform. Every data field is snake_case.')
                .setVersion('1.0')
                .addBearerAuth()
                .build(),
        );
        SwaggerModule.setup('api/docs', app, cleanupOpenApiDoc(document), {
            jsonDocumentUrl: 'api/docs-json',
        });
    }

    return app;
}
