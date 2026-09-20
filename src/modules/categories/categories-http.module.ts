import { Module } from '@nestjs/common';

import { ServicesModule } from '../services/services.module';
import { CategoriesController } from './categories.controller';
import { CategoriesModule } from './categories.module';

@Module({
    imports: [CategoriesModule, ServicesModule],
    controllers: [CategoriesController],
})
export class CategoriesHttpModule {}
