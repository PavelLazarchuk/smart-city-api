import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiData, ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { ROLES, Roles } from '../../common/decorators/roles.decorator';
import { texts } from '../../common/i18n/messages';
import { Serialize, SerializePaginated } from '../../common/http/serialize.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { OtpService } from '../auth/otp.service';
import {
    ListSmsQueryDto,
    SendTestSmsDto,
    SmsResponseDto,
    smsResponseSchema,
    TestSmsResponseDto,
    testSmsResponseSchema,
} from './dto/sms.schemas';
import { type SmsStatus } from './schemas/sms.schema';
import { type SmsEntity } from './sms.repository';
import { SmsService } from './sms.service';

@ApiTags('sms')
@ApiBearerAuth()
@Controller('sms')
@Roles(ROLES.SUPER_ADMIN)
export class SmsController {
    constructor(
        private readonly sms: SmsService,
        private readonly otp: OtpService,
    ) {}

    @Get()
    @ApiPaginated(SmsResponseDto, true)
    @SerializePaginated(smsResponseSchema)
    list(@Query() query: ListSmsQueryDto): Promise<PaginatedResult<SmsEntity>> {
        return this.sms.list(query);
    }

    @Post('test')
    @HttpCode(HttpStatus.OK)
    @ApiData(TestSmsResponseDto)
    @Serialize(testSmsResponseSchema)
    async sendTest(@Body() body: SendTestSmsDto): Promise<{ phone: string; status: SmsStatus }> {
        const status = await this.sms.send(body.phone, texts.sms.test(this.otp.generateCode()), 'test');

        return { phone: body.phone, status };
    }
}
