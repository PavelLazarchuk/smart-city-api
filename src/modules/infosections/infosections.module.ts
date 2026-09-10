import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { OrganizationsModule } from '../organizations/organizations.module';
import { InfoSectionsController } from './infosections.controller';
import { InfoSectionsRepository } from './infosections.repository';
import { InfoSectionsService } from './infosections.service';
import { InfoSection, InfoSectionSchema } from './schemas/infosection.schema';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: InfoSection.name, schema: InfoSectionSchema }]),
        OrganizationsModule,
    ],
    controllers: [InfoSectionsController],
    providers: [InfoSectionsRepository, InfoSectionsService],
    exports: [InfoSectionsService],
})
export class InfoSectionsModule {}
