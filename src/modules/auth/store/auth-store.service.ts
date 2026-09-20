import { Injectable } from '@nestjs/common';
import { type ClientSession } from 'mongoose';

import { type SessionEntity, SessionsRepository } from './sessions.repository';
import { VerificationCodesRepository } from './verification-codes.repository';

@Injectable()
export class AuthStoreService {
    constructor(
        private readonly sessions: SessionsRepository,
        private readonly codes: VerificationCodesRepository,
    ) {}

    findActiveSession(sid: string): Promise<SessionEntity | null> {
        return this.sessions.findActive(sid);
    }

    revokeAllSessions(userId: string, session?: ClientSession, exceptSid?: string): Promise<number> {
        return this.sessions.revokeAllForUser(userId, session, exceptSid);
    }

    deleteCodesForPhone(phone: string, session?: ClientSession): Promise<number> {
        return this.codes.deleteForPhone(phone, session);
    }
}
