import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'smart_city:is_public';

/** No bearer token required. A token that *is* present is still parsed, so the handler sees the principal. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
