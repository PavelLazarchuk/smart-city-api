import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_PASSWORD_KEY = 'smart_city:allow_pending_password';

export const AllowPendingPassword = (): MethodDecorator & ClassDecorator =>
    SetMetadata(ALLOW_PENDING_PASSWORD_KEY, true);
