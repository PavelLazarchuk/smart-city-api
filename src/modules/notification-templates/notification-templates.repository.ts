import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { type NotificationKey } from './notification-catalogue';
import { NotificationTemplate } from './schemas/notification-template.schema';

export type NotificationTemplateEntity = Lean<NotificationTemplate>;

@Injectable()
export class NotificationTemplatesRepository extends BaseRepository<NotificationTemplate> {
    constructor(@InjectModel(NotificationTemplate.name) model: Model<NotificationTemplate>) {
        super(model);
    }

    find(organizationId: string, key: NotificationKey): Promise<NotificationTemplateEntity | null> {
        return this.findOne({ organization_id: new Types.ObjectId(organizationId), key });
    }

    listByOrganization(organizationId: string): Promise<NotificationTemplateEntity[]> {
        return this.findMany({ organization_id: new Types.ObjectId(organizationId) });
    }

    save(
        organizationId: string,
        key: NotificationKey,
        set: { subject: string | null; body: string; updated_by: Types.ObjectId },
    ): Promise<NotificationTemplateEntity> {
        return this.model
            .findOneAndUpdate(
                { organization_id: new Types.ObjectId(organizationId), key },
                { $set: set },
                { upsert: true, new: true },
            )
            .lean<NotificationTemplateEntity>()
            .exec();
    }

    async remove(organizationId: string, key: NotificationKey): Promise<void> {
        await this.deleteMany({ organization_id: new Types.ObjectId(organizationId), key });
    }

    deleteByOrganization(organizationId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ organization_id: new Types.ObjectId(organizationId) }, session);
    }
}
