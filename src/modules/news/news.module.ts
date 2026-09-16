import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { ImagesModule } from '../images/images.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { NewsController } from './news.controller';
import { NewsRepository } from './news.repository';
import { NewsService } from './news.service';
import { News, NewsSchema } from './schemas/news.schema';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: News.name, schema: NewsSchema }]),
        OrganizationsModule,
        ImagesModule,
    ],
    controllers: [NewsController],
    providers: [NewsRepository, NewsService],
    exports: [NewsService],
})
export class NewsModule {}
