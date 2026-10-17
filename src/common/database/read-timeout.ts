import { type Aggregate, type Query, type Schema } from 'mongoose';

const READ_OPERATIONS: ('find' | 'findOne' | 'countDocuments' | 'distinct' | 'estimatedDocumentCount')[] = [
    'find',
    'findOne',
    'countDocuments',
    'distinct',
    'estimatedDocumentCount',
];

export function readTimeout(ms: number): (schema: Schema) => void {
    return (schema) => {
        schema.pre(READ_OPERATIONS, function (this: Query<unknown, unknown>) {
            if (this.getOptions().maxTimeMS === undefined) this.maxTimeMS(ms);
        });
        schema.pre('aggregate', function (this: Aggregate<unknown>) {
            if (this.options.maxTimeMS === undefined) this.option({ maxTimeMS: ms });
        });
    };
}
