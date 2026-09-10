export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

export interface StoredFile {
    key: string;
    url: string;
}

export interface StorageProvider {
    put(key: string, content: Buffer, mimeType: string): Promise<StoredFile>;
    delete(key: string): Promise<void>;
    urlFor(key: string): string;
}
