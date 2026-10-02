import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { type ClientSession, type FilterQuery, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { type ResolvedPagination } from '../../common/pagination/pagination.service';
import { BookingSuspension } from './schemas/suspension.schema';

export type BookingSuspensionEntity = Lean<BookingSuspension>;

export interface SuspensionSubject {
    user_id: Types.ObjectId;
    service_id: Types.ObjectId;
    organization_id: Types.ObjectId;
    service_label: string;
}

@Injectable()
export class SuspensionsRepository extends BaseRepository<BookingSuspension> {
    constructor(@InjectModel(BookingSuspension.name) model: Model<BookingSuspension>) {
        super(model);
    }

    findByPublicId(id: string, session?: ClientSession): Promise<BookingSuspensionEntity | null> {
        return this.findOne({ id }, session);
    }

    findForClient(
        userId: string,
        serviceId: string,
        session?: ClientSession,
    ): Promise<BookingSuspensionEntity | null> {
        return this.findOne(
            { user_id: new Types.ObjectId(userId), service_id: new Types.ObjectId(serviceId) },
            session,
        );
    }

    touch(subject: SuspensionSubject, now: Date, session?: ClientSession): Promise<BookingSuspensionEntity> {
        return this.model
            .findOneAndUpdate(
                { user_id: subject.user_id, service_id: subject.service_id },
                {
                    $setOnInsert: {
                        id: randomUUID(),
                        organization_id: subject.organization_id,
                        service_label: subject.service_label,
                    },
                    $set: { touched_at: now },
                },
                { upsert: true, new: true, session },
            )
            .lean<BookingSuspensionEntity>()
            .exec();
    }

    update(
        id: string,
        set: Partial<BookingSuspension>,
        session?: ClientSession,
    ): Promise<BookingSuspensionEntity | null> {
        return this.model
            .findOneAndUpdate({ id }, { $set: set }, { new: true, session })
            .lean<BookingSuspensionEntity>()
            .exec();
    }

    list(
        filter: FilterQuery<BookingSuspension>,
        pagination: ResolvedPagination,
    ): Promise<PaginatedResult<BookingSuspensionEntity>> {
        return this.paginate(filter, pagination);
    }

    deleteByUser(userId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ user_id: new Types.ObjectId(userId) }, session);
    }

    deleteByService(serviceId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ service_id: new Types.ObjectId(serviceId) }, session);
    }

    deleteByOrganization(organizationId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ organization_id: new Types.ObjectId(organizationId) }, session);
    }
}
