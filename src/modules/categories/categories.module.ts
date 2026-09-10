import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { OrganizationsModule } from '../organizations/organizations.module';
import { CategoriesRepository } from './categories.repository';
import { CategoriesService } from './categories.service';
import { Category, CategorySchema } from './schemas/category.schema';

/**
 * Domain module only. The controller lives in `CategoriesHttpModule` because it also needs
 * `ServicesService`, while `ServicesModule` needs this one — the split removes the `forwardRef` cycle.
 */
@Module({
    imports: [
        MongooseModule.forFeature([{ name: Category.name, schema: CategorySchema }]),
        OrganizationsModule,
    ],
    providers: [CategoriesRepository, CategoriesService],
    exports: [CategoriesService],
})
export class CategoriesModule {}
