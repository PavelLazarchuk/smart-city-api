import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type AppConfig } from '../../common/config/app-config';
import { LocalStorageProvider } from './local-storage.provider';

describe('LocalStorageProvider', () => {
    let root: string;
    let provider: LocalStorageProvider;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'storage-spec-'));
        provider = new LocalStorageProvider({
            storage: { local: { dir: join(root, 'uploads'), publicUrl: 'http://cdn.local/uploads' } },
        } as unknown as AppConfig);
    });
    afterEach(() => rm(root, { recursive: true, force: true }));

    const listAll = async () => {
        const keys: string[] = [];

        for await (const object of provider.list()) keys.push(object.key);

        return keys.sort();
    };

    it('lists nothing before anything was written', async () => {
        expect(await listAll()).toEqual([]);
    });

    it('stores nested keys, lists them with forward slashes and deletes them', async () => {
        await expect(provider.put('org/2026/a.jpg', Buffer.from('abc'), 'image/jpeg')).resolves.toEqual({
            key: 'org/2026/a.jpg',
            url: 'http://cdn.local/uploads/org/2026/a.jpg',
        });
        await provider.put('b.png', Buffer.from('b'), 'image/png');

        expect(await listAll()).toEqual(['b.png', 'org/2026/a.jpg']);

        await provider.delete('org/2026/a.jpg');
        await provider.delete('never-written.jpg');
        expect(await listAll()).toEqual(['b.png']);
    });

    it('skips entries that are neither files nor directories', async () => {
        await provider.put('real.jpg', Buffer.from('x'), 'image/jpeg');
        await symlink(join(root, 'missing-target'), join(root, 'uploads', 'dangling'));

        expect(await listAll()).toEqual(['real.jpg']);
    });

    it('refuses a key that climbs out of the upload directory', async () => {
        await expect(provider.put('../escape.jpg', Buffer.from('x'), 'image/jpeg')).rejects.toThrow(
            'storage key escapes the upload directory',
        );
        await expect(provider.delete('../../etc/passwd')).rejects.toThrow();
    });

    it('surfaces a read error other than a missing directory', async () => {
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'uploads'), 'not a directory');

        await expect(listAll()).rejects.toMatchObject({ code: 'ENOTDIR' });
    });

    it('creates the directory on the health check', async () => {
        await expect(provider.check()).resolves.toBeUndefined();
    });
});
