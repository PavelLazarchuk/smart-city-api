import './test-env';
import { type INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { type Connection } from 'mongoose';
import request, { type Agent } from 'supertest';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { AppConfig } from '../../src/common/config/app-config';

export interface TestApp {
    app: INestApplication;
    http: Agent;
    connection: Connection;
    config: AppConfig;
    prefix: string;
    clearDatabase(): Promise<void>;
    close(): Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    configureApp(app);
    await app.init();
    const connection = app.get<Connection>(getConnectionToken());
    await Promise.all(Object.values(connection.models).map((model) => model.init()));
    const config = app.get(AppConfig);

    return {
        app,
        http: request(app.getHttpServer()),
        connection,
        config,
        prefix: `/${config.http.prefix}`,
        clearDatabase: async () => {
            await Promise.all(
                Object.values(connection.collections).map((collection) => collection.deleteMany({})),
            );
        },
        close: async () => {
            await connection.dropDatabase();
            await app.close();
        },
    };
}
