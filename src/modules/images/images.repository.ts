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

    /** Which of these storage keys still have a row — the `storage_gc` question, asked per batch. */
    async existingNames(names: string[]): Promise<Set<string>> {
        const rows = await this.model
            .find({ name: { $in: names } }, { name: 1, _id: 0 })
            .lean<{ name: string }[]>()
            .exec();

        return new Set(rows.map((row) => row.name));
    }

    /** Streams every image for the job that has to look at all of them. */
    iterateAll(): AsyncIterable<ImageEntity> {
        return this.model
            .find({}, { organization_id: 1, name: 1, src: 1, size: 1, created_at: 1 })
            .lean<ImageEntity>()
            .cursor({ batchSize: 200 });
    }
}
