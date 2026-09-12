import { Injectable } from '@nestjs/common';
import { access, constants, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { AppConfig } from '../../common/config/app-config';
import { type StorageProvider, type StoredFile, type StoredObject } from './storage.provider';

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

    async check(): Promise<void> {
        await mkdir(this.root, { recursive: true });
        await access(this.root, constants.W_OK);
    }

    /** Depth-first walk of the upload directory; keys are `/`-joined paths relative to its root. */
    async *list(): AsyncIterable<StoredObject> {
        yield* this.walk(this.root);
    }

    private async *walk(directory: string): AsyncIterable<StoredObject> {
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
            // A store nothing has been written to yet simply holds no objects.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;

            throw error;
        }

        for (const entry of entries) {
            const path = join(directory, entry.name);

            if (entry.isDirectory()) {
                yield* this.walk(path);
                continue;
            }

            if (!entry.isFile()) continue;

            const stats = await stat(path);

            yield {
                key: relative(this.root, path).split(sep).join('/'),
                size: stats.size,
                modified_at: stats.mtime,
            };
        }
    }

    private pathFor(key: string): string {
        const path = resolve(join(this.root, key));

        if (!path.startsWith(this.root + sep)) throw new Error('storage key escapes the upload directory');

        return path;
    }
}
