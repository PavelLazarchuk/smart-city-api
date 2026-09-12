import {
    DeleteObjectCommand,
    HeadBucketCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';

import { AppConfig } from '../../common/config/app-config';
import { type StorageProvider, type StoredFile, type StoredObject } from './storage.provider';

@Injectable()
export class S3StorageProvider implements StorageProvider {
    private client: S3Client | undefined;

    constructor(private readonly config: AppConfig) {}

    async put(key: string, content: Buffer, mimeType: string): Promise<StoredFile> {
        await this.s3().send(
            new PutObjectCommand({
                Bucket: this.config.storage.s3.bucket,
                Key: key,
                Body: content,
                ContentType: mimeType,
            }),
        );

        return { key, url: this.urlFor(key) };
    }

    async delete(key: string): Promise<void> {
        await this.s3().send(new DeleteObjectCommand({ Bucket: this.config.storage.s3.bucket, Key: key }));
    }

    urlFor(key: string): string {
        const { bucket, region, endpoint } = this.config.storage.s3;

        if (endpoint) return `${endpoint.replace(/\/+$/, '')}/${bucket}/${key}`;

        return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
    }

    async check(): Promise<void> {
        await this.s3().send(new HeadBucketCommand({ Bucket: this.config.storage.s3.bucket }));
    }

    /** `ListObjectsV2` followed through its continuation tokens, a page of a thousand keys at a time. */
    async *list(): AsyncIterable<StoredObject> {
        let token: string | undefined;

        do {
            const page = await this.s3().send(
                new ListObjectsV2Command({
                    Bucket: this.config.storage.s3.bucket,
                    ContinuationToken: token,
                }),
            );

            for (const object of page.Contents ?? []) {
                if (!object.Key) continue;

                yield {
                    key: object.Key,
                    size: object.Size ?? 0,
                    modified_at: object.LastModified ?? new Date(0),
                };
            }

            token = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (token);
    }

    private s3(): S3Client {
        if (!this.client) {
            const { region, endpoint, accessKeyId, secretAccessKey } = this.config.storage.s3;
            this.client = new S3Client({
                region,
                endpoint,
                forcePathStyle: Boolean(endpoint),
                credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
            });
        }

        return this.client;
    }
}
