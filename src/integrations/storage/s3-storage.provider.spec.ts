import {
    DeleteObjectCommand,
    HeadBucketCommand,
    type ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';

import { type AppConfig } from '../../common/config/app-config';
import { S3StorageProvider } from './s3-storage.provider';

function providerWith(s3: Partial<AppConfig['storage']['s3']>): S3StorageProvider {
    return new S3StorageProvider({
        storage: { s3: { bucket: 'city', region: 'eu-central-1', ...s3 } },
    } as unknown as AppConfig);
}

describe('S3StorageProvider', () => {
    let send: jest.SpyInstance;

    beforeEach(() => {
        send = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    });
    afterEach(() => jest.restoreAllMocks());

    it('builds virtual-hosted URLs on AWS and path-style ones on a custom endpoint', () => {
        expect(providerWith({}).urlFor('org/a.jpg')).toBe(
            'https://city.s3.eu-central-1.amazonaws.com/org/a.jpg',
        );
        expect(providerWith({ endpoint: 'http://minio:9000//' }).urlFor('org/a.jpg')).toBe(
            'http://minio:9000/city/org/a.jpg',
        );
    });

    it('uploads with the content type and answers the public URL', async () => {
        const provider = providerWith({});

        await expect(provider.put('org/a.jpg', Buffer.from('x'), 'image/jpeg')).resolves.toEqual({
            key: 'org/a.jpg',
            url: 'https://city.s3.eu-central-1.amazonaws.com/org/a.jpg',
        });

        const command = send.mock.calls[0]![0] as PutObjectCommand;
        expect(command).toBeInstanceOf(PutObjectCommand);
        expect(command.input).toMatchObject({ Bucket: 'city', Key: 'org/a.jpg', ContentType: 'image/jpeg' });
    });

    it('deletes by key and checks the bucket', async () => {
        const provider = providerWith({});

        await provider.delete('org/a.jpg');
        await provider.check();

        expect(send.mock.calls[0]![0]).toBeInstanceOf(DeleteObjectCommand);
        expect((send.mock.calls[0]![0] as DeleteObjectCommand).input).toEqual({
            Bucket: 'city',
            Key: 'org/a.jpg',
        });
        expect(send.mock.calls[1]![0]).toBeInstanceOf(HeadBucketCommand);
    });

    it('reuses one client for every call', async () => {
        const provider = providerWith({
            accessKeyId: 'id',
            secretAccessKey: 'secret',
            endpoint: 'http://minio:9000',
        });

        await provider.check();
        await provider.check();

        expect(new Set(send.mock.contexts).size).toBe(1);
    });

    it('pages through the bucket, skipping keyless entries and defaulting missing fields', async () => {
        const modified = new Date('2026-01-01T00:00:00Z');
        send.mockResolvedValueOnce({
            Contents: [{ Key: 'a', Size: 3, LastModified: modified }, { Size: 1 }],
            IsTruncated: true,
            NextContinuationToken: 'next',
        });
        send.mockResolvedValueOnce({ Contents: [{ Key: 'b' }], IsTruncated: false });

        const listed = [];

        for await (const object of providerWith({}).list()) listed.push(object);

        expect(listed).toEqual([
            { key: 'a', size: 3, modified_at: modified },
            { key: 'b', size: 0, modified_at: new Date(0) },
        ]);
        const commands = send.mock.calls.map(([command]) => command as ListObjectsV2Command);
        expect(commands.map((command) => command.input.ContinuationToken)).toEqual([undefined, 'next']);
    });

    it('answers nothing for an empty bucket', async () => {
        const listed = [];

        for await (const object of providerWith({}).list()) listed.push(object);

        expect(listed).toEqual([]);
        expect(send).toHaveBeenCalledTimes(1);
    });
});
