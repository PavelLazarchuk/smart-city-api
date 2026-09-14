import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { IdempotencyService } from './idempotency.service';
import { IdempotencyKey, IdempotencyKeySchema } from './schemas/idempotency-key.schema';

@Global()
@Module({
    imports: [MongooseModule.forFeature([{ name: IdempotencyKey.name, schema: IdempotencyKeySchema }])],
    providers: [IdempotencyService],
    exports: [IdempotencyService],
})
export class IdempotencyModule {}
