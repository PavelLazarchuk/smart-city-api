import { type MongoMemoryReplSet } from 'mongodb-memory-server';

export default async function globalTeardown(): Promise<void> {
    const replSet = (globalThis as { __MONGO_REPLSET__?: MongoMemoryReplSet }).__MONGO_REPLSET__;

    if (replSet) await replSet.stop({ doCleanup: true, force: true });
}
