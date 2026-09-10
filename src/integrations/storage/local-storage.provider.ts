import { Injectable } from '@nestjs/common';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { AppConfig } from '../../common/config/app-config';
import { type StorageProvider, type StoredFile } from './storage.provider';

@Injectable()
export class LocalStorageProvider implements StorageProvider {
    private readonly root: string;

    constructor(private readonly config: AppConfig) {
        this.root = resolve(config.storage.local.dir);
    }

    async put(key: string, content: Buffer, _mimeType: string): Promise<StoredFile> {
        const path = this.pathFor(key);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);

        return { key, url: this.urlFor(key) };
    }

    async delete(key: string): Promise<void> {
        await rm(this.pathFor(key), { force: true });
    }

    urlFor(key: string): string {
        return `${this.config.storage.local.publicUrl}/${key}`;
    }

    private pathFor(key: string): string {
        const path = resolve(join(this.root, key));

        if (!path.startsWith(this.root + sep)) throw new Error('storage key escapes the upload directory');

        return path;
    }
}
