import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { ROLE_VALUES } from '../../../common/decorators/roles.decorator';
import { paginationQuerySchema } from '../../../common/pagination/pagination.schema';
import {
    idOutputSchema,
    isoDateTimeSchema,
    loginSchema,
    nameSchema,
    objectIdSchema,
    passwordSchema,
    phoneSchema,
    timestampsOutputSchema,
} from '../../../common/zod/primitives';

export const userResponseSchema = z.object({
    id: idOutputSchema,
    login: z.string().optional(),
    name: z.string().optional(),
    phone: z.string().optional(),
    role: z.enum(ROLE_VALUES),
    organization_ids: z.array(idOutputSchema),
    ...timestampsOutputSchema,
});
export type UserResponse = z.infer<typeof userResponseSchema>;
export class UserResponseDto extends createZodDto(userResponseSchema) {}

/** One row of `GET /users/:id/bookings`, read from the `bookings` collection. */
export const userBookingResponseSchema = z.object({
    id: z.string(),
    service_id: idOutputSchema,
    organization_id: idOutputSchema,
    option_id: z.string(),
    slot_id: z.string(),
    child_type: z.string(),
    service_label: z.string().catch(''),
    date: z.string().optional(),
    time: z.string().optional(),
    info: z.string().catch(''),
    status: z.string().catch('confirmed'),
    created_at: isoDateTimeSchema,
});
export class UserBookingResponseDto extends createZodDto(userBookingResponseSchema) {}

export const createUserSchema = z.object({
    login: loginSchema.optional(),
    password: passwordSchema.optional(),
    phone: phoneSchema.optional(),
    name: nameSchema.optional(),
    role: z.enum(ROLE_VALUES),
    organization_ids: z.array(objectIdSchema).max(100).optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;
export class CreateUserDto extends createZodDto(createUserSchema) {}

export const updateSelfSchema = z.object({ name: nameSchema }).partial();
export type UpdateSelfInput = z.infer<typeof updateSelfSchema>;
export class UpdateSelfDto extends createZodDto(updateSelfSchema) {}

/** What a super-admin may change on any account. `null` clears an optional identifier. */
export const updateUserAdminSchema = z
    .object({
        login: loginSchema.nullable(),
        name: nameSchema.nullable(),
        phone: phoneSchema.nullable(),
        password: passwordSchema,
        role: z.enum(ROLE_VALUES),
    })
    .partial();
export type UpdateUserAdminInput = z.infer<typeof updateUserAdminSchema>;
export class UpdateUserAdminDto extends createZodDto(updateUserAdminSchema) {}

export const setUserOrganizationsSchema = z.object({
    organization_ids: z.array(objectIdSchema).max(100),
});
export class SetUserOrganizationsDto extends createZodDto(setUserOrganizationsSchema) {}

export const listUsersQuerySchema = paginationQuerySchema.extend({
    role: z.enum(ROLE_VALUES).optional(),
    organization_id: objectIdSchema.optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export class ListUsersQueryDto extends createZodDto(listUsersQuerySchema) {}
