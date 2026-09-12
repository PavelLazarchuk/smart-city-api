export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

export interface StoredFile {
    key: string;
    url: string;
}

export interface StoredObject {
    key: string;
    size: number;
    modified_at: Date;
}

export interface StorageProvider {
    put(key: string, content: Buffer, mimeType: string): Promise<StoredFile>;
    delete(key: string): Promise<void>;
    urlFor(key: string): string;
    /** Readiness probe: resolves when the backing store accepts requests, rejects otherwise. */
    check(): Promise<void>;
    /**
     * Every object the store holds, streamed. A bucket is larger than memory in principle, so the
     * `storage_gc` job consumes this page by page instead of collecting it into an array.
     */
    list(): AsyncIterable<StoredObject>;
}
