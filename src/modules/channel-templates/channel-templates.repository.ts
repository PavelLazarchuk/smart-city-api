import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { type ChannelTemplateKey } from './channel-catalogue';
import { ChannelTemplate } from './schemas/channel-template.schema';

export type ChannelTemplateEntity = Lean<ChannelTemplate>;

@Injectable()
export class ChannelTemplatesRepository extends BaseRepository<ChannelTemplate> {
    constructor(@InjectModel(ChannelTemplate.name) model: Model<ChannelTemplate>) {
        super(model);
    }

    find(organizationId: string, key: ChannelTemplateKey): Promise<ChannelTemplateEntity | null> {
        return this.findOne({ organization_id: new Types.ObjectId(organizationId), key });
    }

    listByOrganization(organizationId: string): Promise<ChannelTemplateEntity[]> {
        return this.findMany({ organization_id: new Types.ObjectId(organizationId) });
    }

    save(
        organizationId: string,
        key: ChannelTemplateKey,
        set: { subject: string | null; body: string; updated_by: Types.ObjectId },
    ): Promise<ChannelTemplateEntity> {
        return this.model
            .findOneAndUpdate(
                { organization_id: new Types.ObjectId(organizationId), key },
                { $set: set },
                { upsert: true, new: true },
            )
            .lean<ChannelTemplateEntity>()
            .exec();
    }

    async remove(organizationId: string, key: ChannelTemplateKey): Promise<void> {
        await this.deleteMany({ organization_id: new Types.ObjectId(organizationId), key });
    }

    deleteByOrganization(organizationId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ organization_id: new Types.ObjectId(organizationId) }, session);
    }
}
