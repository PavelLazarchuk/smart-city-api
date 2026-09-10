import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { nextPosition, reorderSiblings } from '../../common/database/reorder';
import { InfoSection } from './schemas/infosection.schema';

export type InfoSectionEntity = Lean<InfoSection>;

@Injectable()
export class InfoSectionsRepository extends BaseRepository<InfoSection> {
    constructor(@InjectModel(InfoSection.name) model: Model<InfoSection>) {
        super(model);
    }

    nextPosition(organizationId: string, session?: ClientSession): Promise<number> {
        return nextPosition(this.model, { organization_id: new Types.ObjectId(organizationId) }, session);
    }

    reorder(organizationId: string, ids: string[], session?: ClientSession): Promise<void> {
        return reorderSiblings(
            this.model,
            { organization_id: new Types.ObjectId(organizationId) },
            ids,
            session,
        );
    }

    deleteByOrganization(organizationId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ organization_id: new Types.ObjectId(organizationId) }, session);
    }
}
