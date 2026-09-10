import { Module } from '@nestjs/common';

import { ServicesModule } from '../services/services.module';
import { CategoriesController } from './categories.controller';
import { CategoriesModule } from './categories.module';

/** The categories HTTP surface also reorders the category's services, so it needs both modules. */
@Module({
    imports: [CategoriesModule, ServicesModule],
    controllers: [CategoriesController],
})
export class CategoriesHttpModule {}
