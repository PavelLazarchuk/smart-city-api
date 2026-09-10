import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppConfig } from './app-config';
import { validateEnv } from './env.schema';

@Global()
@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: process.env['NODE_ENV'] === 'test',
            validate: (raw) => validateEnv(raw),
        }),
    ],
    providers: [
        {
            provide: AppConfig,
            useFactory: () => new AppConfig(validateEnv(process.env)),
        },
    ],
    exports: [AppConfig],
})
export class AppConfigModule {}
