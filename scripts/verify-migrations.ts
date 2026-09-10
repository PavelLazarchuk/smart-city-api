import { MongoMemoryReplSet } from 'mongodb-memory-server';

interface Db {
    listCollections(): { toArray(): Promise<{ name: string }[]> };
    collection(name: string): { indexes(): Promise<{ name: string }[]> };
}

async function main(): Promise<void> {
    const migrateMongo = await import('migrate-mongo');
    const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    const uri = replSet.getUri('migrations_verify');

    try {
        migrateMongo.config.set({
            mongodb: { url: uri, options: {} },
            migrationsDir: 'migrations',
            changelogCollectionName: 'migrations_changelog',
            lockCollectionName: 'migrations_lock',
            lockTtl: 0,
            migrationFileExtension: '.js',
            useFileHash: false,
            moduleSystem: 'commonjs',
        });
        const { db, client } = await migrateMongo.database.connect();

        try {
            const applied = await migrateMongo.up(db, client);
            console.log(`up: ${applied.length} migration(s) applied`);
            const status = await migrateMongo.status(db);

            for (const item of status) console.log(`  ${item.fileName}: ${item.appliedAt}`);

            if (status.some((item) => item.appliedAt === 'PENDING'))
                throw new Error('migrations pending after up');

            const reverted: string[] = [];

            for (let i = 0; i < applied.length; i += 1)
                reverted.push(...(await migrateMongo.down(db, client)));

            console.log(`down: ${reverted.length} migration(s) reverted`);

            const typedDb = db as unknown as Db;
            const leftovers: string[] = [];

            for (const { name } of await typedDb.listCollections().toArray()) {
                if (name.startsWith('migrations_')) continue;

                const indexes = await typedDb.collection(name).indexes();

                for (const index of indexes)
                    if (index.name !== '_id_') leftovers.push(`${name}.${index.name}`);
            }

            if (leftovers.length > 0) throw new Error(`down left indexes behind: ${leftovers.join(', ')}`);

            console.log('migrations verified: up and down are clean');
        } finally {
            await client.close();
        }
    } finally {
        await replSet.stop();
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
