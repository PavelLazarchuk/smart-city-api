import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
    idOutputSchema,
    isoDateTimeSchema,
    loginSchema,
    nameSchema,
    passwordSchema,
    phoneSchema,
} from '../../../common/zod/primitives';
import { userResponseSchema } from '../../users/dto/user.schemas';

export const loginRequestSchema = z
    .object({
        login: loginSchema.optional(),
        phone: phoneSchema.optional(),
        password: passwordSchema,
    })
    .refine((value) => Boolean(value.login) !== Boolean(value.phone), {
        message: 'Provide exactly one of login or phone',
        path: ['login'],
    });
export type LoginInput = z.infer<typeof loginRequestSchema>;
export class LoginDto extends createZodDto(loginRequestSchema) {}

export const registerRequestSchema = z.object({
    phone: phoneSchema,
    password: passwordSchema,
    name: nameSchema,
});
export type RegisterInput = z.infer<typeof registerRequestSchema>;
export class RegisterDto extends createZodDto(registerRequestSchema) {}

export const otpRequestSchema = z.object({ phone: phoneSchema });
export class OtpRequestDto extends createZodDto(otpRequestSchema) {}

export const otpVerifySchema = z.object({
    phone: phoneSchema,
    code: z.string().regex(/^\d{4,10}$/, 'Must be the numeric verification code'),
    name: nameSchema.optional(),
});
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;
export class OtpVerifyDto extends createZodDto(otpVerifySchema) {}

export const refreshRequestSchema = z.object({ refresh_token: z.string().min(1) });
export class RefreshDto extends createZodDto(refreshRequestSchema) {}

export const changePasswordSchema = z
    .object({
        current_password: passwordSchema.optional(),
        new_password: passwordSchema,
        new_password_confirmation: passwordSchema,
    })
    .refine((value) => value.new_password === value.new_password_confirmation, {
        message: 'Passwords do not match',
        path: ['new_password_confirmation'],
    });
export class ChangePasswordDto extends createZodDto(changePasswordSchema) {}

export const tokenPairResponseSchema = z.object({
    access_token: z.string(),
    refresh_token: z.string(),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int(),
    user: userResponseSchema,
});
export type TokenPairResponse = z.infer<typeof tokenPairResponseSchema>;
export class TokenPairResponseDto extends createZodDto(tokenPairResponseSchema) {}

export const sessionResponseSchema = z.object({
    id: idOutputSchema,
    current: z.boolean(),
    user_agent: z.string().optional(),
    ip: z.string().optional(),
    expires_at: isoDateTimeSchema,
    created_at: isoDateTimeSchema,
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export class SessionResponseDto extends createZodDto(sessionResponseSchema) {}

export const otpRequestResponseSchema = z.object({
    phone: z.string(),
    expires_in: z.number().int(),
});
export class OtpRequestResponseDto extends createZodDto(otpRequestResponseSchema) {}
