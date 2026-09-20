import { SetMetadata } from '@nestjs/common';
import { type Request } from 'express';
import { type ZodType } from 'zod';

export const SERIALIZE_METADATA = 'smart_city:serialize';

export type SerializeKind = 'single' | 'list' | 'paginated';

export interface SerializeOptions {
    schema: ZodType;
    kind: SerializeKind;
    schemaFor?: (request: Request) => ZodType;
}

export const SPARSE_FIELDS_METADATA = 'smart_city:sparse_fields';

export const SparseFields = (): MethodDecorator => SetMetadata(SPARSE_FIELDS_METADATA, true);

/** Unknown keys are stripped, so a field absent from the schema can never reach a client. */
export const Serialize = (schema: ZodType, kind: SerializeKind = 'single'): MethodDecorator =>
    SetMetadata<string, SerializeOptions>(SERIALIZE_METADATA, { schema, kind });

export const SerializeList = (schema: ZodType): MethodDecorator => Serialize(schema, 'list');
export const SerializePaginated = (schema: ZodType): MethodDecorator => Serialize(schema, 'paginated');

export const SerializeBy = (
    schemaFor: (request: Request) => ZodType,
    fallback: ZodType,
    kind: SerializeKind = 'single',
): MethodDecorator =>
    SetMetadata<string, SerializeOptions>(SERIALIZE_METADATA, { schema: fallback, kind, schemaFor });
