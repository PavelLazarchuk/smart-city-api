import 'source-map-support/register';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { AppConfig } from './common/config/app-config';

async function bootstrap(): Promise<void> {
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
        bufferLogs: true,
        bodyParser: false,
    });
    configureApp(app);
    const config = app.get(AppConfig);
    await app.listen(config.http.port);
    app.get(Logger).log(`listening on port ${config.http.port} (${config.env})`, 'bootstrap');
}

bootstrap().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
