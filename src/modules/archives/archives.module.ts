import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { OrganizationsModule } from '../organizations/organizations.module';
import { ArchivesController } from './archives.controller';
import { ArchivesRepository } from './archives.repository';
import { ArchivesService } from './archives.service';
import { Archive, ArchiveSchema } from './schemas/archive.schema';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: Archive.name, schema: ArchiveSchema }]),
        OrganizationsModule,
    ],
    controllers: [ArchivesController],
    providers: [ArchivesRepository, ArchivesService],
    exports: [ArchivesService],
})
export class ArchivesModule {}
