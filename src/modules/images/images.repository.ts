import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { Image } from './schemas/image.schema';

export type ImageEntity = Lean<Image>;

@Injectable()
export class ImagesRepository extends BaseRepository<Image> {
    constructor(@InjectModel(Image.name) model: Model<Image>) {
        super(model);
    }

    findByOrganization(organizationId: string, session?: ClientSession): Promise<ImageEntity[]> {
        return this.findMany({ organization_id: new Types.ObjectId(organizationId) }, { _id: 1 }, session);
    }

    deleteByOrganization(organizationId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ organization_id: new Types.ObjectId(organizationId) }, session);
    }
}
