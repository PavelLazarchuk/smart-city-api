import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, Model, Types } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { type ResolvedPagination } from '../../common/pagination/pagination.service';
import { ServiceRevision } from './schemas/service-revision.schema';

export type ServiceRevisionEntity = Lean<ServiceRevision>;

@Injectable()
export class ServiceRevisionsRepository extends BaseRepository<ServiceRevision> {
    constructor(@InjectModel(ServiceRevision.name) model: Model<ServiceRevision>) {
        super(model);
    }

    listByService(
        serviceId: string,
        pagination: ResolvedPagination,
    ): Promise<PaginatedResult<ServiceRevisionEntity>> {
        return this.paginate({ service_id: new Types.ObjectId(serviceId) }, pagination);
    }

    deleteByService(serviceId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ service_id: new Types.ObjectId(serviceId) }, session);
    }

    deleteByOrganization(organizationId: string, session?: ClientSession): Promise<number> {
        return this.deleteMany({ organization_id: new Types.ObjectId(organizationId) }, session);
    }
}
