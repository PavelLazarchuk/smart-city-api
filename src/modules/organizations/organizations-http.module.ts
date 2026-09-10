import { Module } from '@nestjs/common';

import { CategoriesModule } from '../categories/categories.module';
import { ImagesModule } from '../images/images.module';
import { InfoSectionsModule } from '../infosections/infosections.module';
import { NewsModule } from '../news/news.module';
import { ServicesModule } from '../services/services.module';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsModule } from './organizations.module';

/** The organizations HTTP surface needs every child service for sub-resource lists and reorders. */
@Module({
    imports: [
        OrganizationsModule,
        NewsModule,
        InfoSectionsModule,
        CategoriesModule,
        ServicesModule,
        ImagesModule,
    ],
    controllers: [OrganizationsController],
})
export class OrganizationsHttpModule {}
