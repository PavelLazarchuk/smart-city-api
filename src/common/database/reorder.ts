import { type ClientSession, type FilterQuery, type Model, Types } from 'mongoose';

import { ApiError } from '../http/api-error';

/**
 * Explicit ordering: assigns `position = index` to every id of a sibling set in one
 * `bulkWrite`. The ids must be exactly the current siblings, otherwise `422 REORDER_MISMATCH`.
 */
export async function reorderSiblings<TDoc>(
    model: Model<TDoc>,
    siblingsFilter: FilterQuery<TDoc>,
    ids: string[],
    session?: ClientSession,
): Promise<void> {
    const current = await model
        .find(siblingsFilter, { _id: 1 })
        .session(session ?? null)
        .lean<{ _id: Types.ObjectId }[]>()
        .exec();
    const currentIds = new Set(current.map((row) => row._id.toHexString()));
    const requested = new Set(ids);

    if (
        requested.size !== ids.length ||
        requested.size !== currentIds.size ||
        [...requested].some((id) => !currentIds.has(id))
    ) {
        throw ApiError.unprocessable('REORDER_MISMATCH');
    }

    if (ids.length === 0) return;

    const operations = ids.map((id, position) => ({
        updateOne: { filter: { _id: new Types.ObjectId(id) }, update: { $set: { position } } },
    }));
    await model.bulkWrite(operations as unknown as Parameters<Model<TDoc>['bulkWrite']>[0], {
        session,
        ordered: false,
    });
}

export async function nextPosition<TDoc>(
    model: Model<TDoc>,
    siblingsFilter: FilterQuery<TDoc>,
    session?: ClientSession,
): Promise<number> {
    const last = await model
        .findOne(siblingsFilter, { position: 1 })
        .sort({ position: -1 })
        .session(session ?? null)
        .lean<{ position?: number } | null>()
        .exec();

    return typeof last?.position === 'number' ? last.position + 1 : 0;
}
