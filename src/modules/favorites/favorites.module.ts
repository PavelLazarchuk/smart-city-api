import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { OrganizationsModule } from '../organizations/organizations.module';
import { ServicesModule } from '../services/services.module';
import { FavoritesController } from './favorites.controller';
import { FavoritesRepository } from './favorites.repository';
import { FavoritesService } from './favorites.service';
import { Favorite, FavoriteSchema } from './schemas/favorite.schema';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: Favorite.name, schema: FavoriteSchema }]),
        ServicesModule,
        OrganizationsModule,
    ],
    controllers: [FavoritesController],
    providers: [FavoritesRepository, FavoritesService],
})
export class FavoritesModule {}
