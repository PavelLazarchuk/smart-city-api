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
    check(): Promise<void>;
    /** Streamed: a bucket is larger than memory in principle, so `storage_gc` consumes it page by page. */
    list(): AsyncIterable<StoredObject>;
}
