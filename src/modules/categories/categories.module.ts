import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { OrganizationsModule } from '../organizations/organizations.module';
import { CategoriesRepository } from './categories.repository';
import { CategoriesService } from './categories.service';
import { Category, CategorySchema } from './schemas/category.schema';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: Category.name, schema: CategorySchema }]),
        OrganizationsModule,
    ],
    providers: [CategoriesRepository, CategoriesService],
    exports: [CategoriesService],
})
export class CategoriesModule {}
