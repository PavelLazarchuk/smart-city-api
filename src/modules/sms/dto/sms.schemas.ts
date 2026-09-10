import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { cursorQuerySchema, paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import {
    idOutputSchema,
    isoDateTimeSchema,
    phoneSchema,
    timestampsOutputSchema,
} from '../../../common/zod/primitives';
import { SMS_PURPOSES } from '../schemas/sms.schema';

export const smsResponseSchema = z.object({
    id: idOutputSchema,
    phone: z.string(),
    purpose: z.enum(SMS_PURPOSES),
    provider: z.string(),
    status: z.enum(['sent', 'failed']),
    ...timestampsOutputSchema,
});
export class SmsResponseDto extends createZodDto(smsResponseSchema) {}

/** The range is given either as `?from=&to=` or as a named `?period=`. */
export const listSmsQuerySchema = paginationQuerySchema.extend(cursorQuerySchema.shape).extend({
    from: isoDateTimeSchema.optional(),
    to: isoDateTimeSchema.optional(),
    period: z.enum(['this_month', 'last_month']).optional(),
    phone: phoneSchema.optional(),
});
export type ListSmsQuery = z.infer<typeof listSmsQuerySchema>;
export class ListSmsQueryDto extends createZodDto(listSmsQuerySchema) {}

export const sendTestSmsSchema = z.object({ phone: phoneSchema });
export class SendTestSmsDto extends createZodDto(sendTestSmsSchema) {}

export const testSmsResponseSchema = z.object({ phone: z.string(), status: z.enum(['sent', 'failed']) });
export class TestSmsResponseDto extends createZodDto(testSmsResponseSchema) {}
