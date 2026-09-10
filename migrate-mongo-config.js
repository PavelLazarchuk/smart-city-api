const { existsSync } = require('node:fs');

if (existsSync('.env')) {
    require('dotenv').config();
}

const uri = process.env.MONGO_URI;
if (!uri) {
    throw new Error('MONGO_URI is required to run migrations');
}

module.exports = {
    mongodb: {
        url: uri,
        options: {},
    },
    migrationsDir: 'migrations',
    changelogCollectionName: 'migrations_changelog',
    lockCollectionName: 'migrations_lock',
    lockTtl: 0,
    migrationFileExtension: '.js',
    useFileHash: false,
    moduleSystem: 'commonjs',
};
