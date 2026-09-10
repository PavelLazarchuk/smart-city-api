import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MONGO_STATE_FILE = join(process.cwd(), '.jest-cache', 'mongo.json');

export default async function globalSetup(): Promise<void> {
    const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    const uri = replSet.getUri();
    mkdirSync(join(process.cwd(), '.jest-cache'), { recursive: true });
    writeFileSync(MONGO_STATE_FILE, JSON.stringify({ uri }));
    process.env['JEST_MONGO_URI'] = uri;
    (globalThis as { __MONGO_REPLSET__?: MongoMemoryReplSet }).__MONGO_REPLSET__ = replSet;
}
