import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { BaseRepository, type Lean } from '../../common/database/base.repository';
import { Sms } from './schemas/sms.schema';

export type SmsEntity = Lean<Sms>;

@Injectable()
export class SmsRepository extends BaseRepository<Sms> {
    constructor(@InjectModel(Sms.name) model: Model<Sms>) {
        super(model);
    }
}
