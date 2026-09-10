import { Injectable } from '@nestjs/common';

import { AppConfig } from '../../common/config/app-config';
import { ApiError } from '../../common/http/api-error';

@Injectable()
export class PhonePolicy {
    constructor(private readonly config: AppConfig) {}

    isSupported(phone: string): boolean {
        return phone.startsWith(this.config.phone.countryCode);
    }

    assertSupported(phone: string): void {
        if (!this.isSupported(phone)) throw ApiError.unprocessable('PHONE_COUNTRY_NOT_SUPPORTED');
    }
}
