import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { type FilterQuery, Types } from 'mongoose';
import { PinoLogger } from 'nestjs-pino';
import sharp from 'sharp';

import { CascadeRegistry } from '../../common/cascade/cascade.registry';
import { AppConfig } from '../../common/config/app-config';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { ScopeResolverRegistry } from '../../common/guards/scope-resolver.registry';
import { ApiError } from '../../common/http/api-error';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { type PaginationQuery } from '../../common/pagination/pagination.schema';
import { PaginationService } from '../../common/pagination/pagination.service';
import { STORAGE_PROVIDER, type StorageProvider } from '../../integrations/storage/storage.provider';
import { OrganizationsService } from '../organizations/organizations.service';
import { type ListImagesQuery } from './dto/image.schemas';
import { type ImageEntity, ImagesRepository } from './images.repository';
import { type Image } from './schemas/image.schema';

export interface UploadedFile {
    originalname: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
}

/**
 * The declared MIME type is a client header, so every type is verified against the file's magic bytes
 * and the stored extension comes from that verified type, never from the file name. Unverifiable types
 * are refused — that is what keeps `UPLOAD_ALLOWED_MIME=image/svg+xml` from becoming stored XSS.
 */
type ImageFormat = 'jpeg' | 'png' | 'webp' | 'gif';

const IMAGE_TYPES: Record<
    string,
    { extension: string; format: ImageFormat; animated?: boolean; matches: (bytes: Buffer) => boolean }
> = {
    'image/jpeg': {
        extension: '.jpg',
        format: 'jpeg',
        matches: (bytes) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    },
    'image/png': {
        extension: '.png',
        format: 'png',
        matches: (bytes) =>
            bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    },
    'image/webp': {
        extension: '.webp',
        format: 'webp',
        animated: true,
        matches: (bytes) =>
            bytes.length > 12 &&
            bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
            bytes.subarray(8, 12).toString('ascii') === 'WEBP',
    },
    'image/gif': {
        extension: '.gif',
        format: 'gif',
        animated: true,
        matches: (bytes) => ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')),
    },
};

@Injectable()
export class ImagesService implements OnModuleInit {
    constructor(
        private readonly images: ImagesRepository,
        @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
        private readonly organizations: OrganizationsService,
        private readonly pagination: PaginationService,
        private readonly config: AppConfig,
        private readonly tx: TransactionRunner,
        private readonly cascade: CascadeRegistry,
        private readonly scopes: ScopeResolverRegistry,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(ImagesService.name);
    }

    onModuleInit(): void {
        this.scopes.register('image', async (id) => {
            const image = await this.images.findById(id);

            return image ? { ...image, organization_id: image.organization_id.toHexString() } : null;
        });
        this.cascade.register('organization', 'images.delete', async (organizationId, ctx) => {
            const images = await this.images.findByOrganization(organizationId, ctx.session);
            await this.images.deleteByOrganization(organizationId, ctx.session);

            for (const image of images) ctx.afterCommit(() => this.removeFile(image.name));
        });
    }

    list(query: ListImagesQuery): Promise<PaginatedResult<ImageEntity>> {
        const pagination = this.pagination.resolve(query, {
            sortable: ['created_at', 'size'],
            defaultSort: 'created_at',
        });
        const filter: FilterQuery<Image> = {};

        if (query.organization_id) filter['organization_id'] = new Types.ObjectId(query.organization_id);

        return this.images.paginate(filter, pagination);
    }

    listByOrganization(
        organizationId: string,
        query: PaginationQuery,
    ): Promise<PaginatedResult<ImageEntity>> {
        return this.list({ ...query, organization_id: organizationId });
    }

    async getById(id: string): Promise<ImageEntity> {
        const image = await this.images.findById(id);

        if (!image) throw ApiError.notFound('IMAGE_NOT_FOUND');

        return image;
    }

    async upload(organizationId: string, file: UploadedFile | undefined): Promise<ImageEntity> {
        if (!file) throw ApiError.badRequest('FILE_REQUIRED');

        if (!this.config.upload.allowedMime.includes(file.mimetype))
            throw ApiError.badRequest('FILE_TYPE_NOT_ALLOWED');

        if (file.size > this.config.upload.maxBytes) throw ApiError.badRequest('FILE_TOO_LARGE');

        await this.organizations.assertExists(organizationId);

        const type = IMAGE_TYPES[file.mimetype];

        if (!type || !type.matches(file.buffer)) throw ApiError.badRequest('FILE_TYPE_NOT_ALLOWED');

        const bytes = await this.transcode(file.buffer, type);
        const key = `${organizationId}/${randomUUID()}${type.extension}`;
        const stored = await this.storage.put(key, bytes, file.mimetype);

        try {
            return await this.images.create({
                organization_id: new Types.ObjectId(organizationId),
                name: stored.key,
                src: stored.url,
                mime_type: file.mimetype,
                size: bytes.length,
            });
        } catch (error) {
            await this.removeFile(stored.key);
            throw error;
        }
    }

    /** Row first, file after the commit so a rolled-back delete never loses a file. */
    async delete(id: string): Promise<void> {
        const image = await this.getById(id);
        await this.tx.run(async (ctx) => {
            await this.images.deleteById(id, ctx.session);
            ctx.afterCommit(() => this.removeFile(image.name));
        });
    }

    private async transcode(
        buffer: Buffer,
        type: { format: ImageFormat; animated?: boolean },
    ): Promise<Buffer> {
        const { maxPixels, maxDimension } = this.config.upload;
        const animated = type.animated ?? false;
        let width = 0;
        let height = 0;

        try {
            const metadata = await sharp(buffer, { limitInputPixels: false, animated }).metadata();
            width = metadata.width ?? 0;
            height = metadata.pageHeight ?? metadata.height ?? 0;
        } catch (error) {
            this.logger.warn({ err: error }, 'uploaded image could not be decoded');
            throw ApiError.badRequest('IMAGE_UNREADABLE');
        }

        if (width === 0 || height === 0) throw ApiError.badRequest('IMAGE_UNREADABLE');

        if (width > maxDimension || height > maxDimension || width * height > maxPixels)
            throw ApiError.unprocessable('IMAGE_TOO_LARGE');

        const pipeline = sharp(buffer, { limitInputPixels: maxPixels, animated });
        let output: Buffer;

        try {
            output = await (type.format === 'jpeg' ? pipeline.rotate() : pipeline)
                .toFormat(type.format)
                .toBuffer();
        } catch (error) {
            this.logger.warn({ err: error }, 'uploaded image could not be re-encoded');
            throw ApiError.badRequest('IMAGE_UNREADABLE');
        }

        return output;
    }

    private async removeFile(key: string): Promise<void> {
        try {
            await this.storage.delete(key);
        } catch (error) {
            this.logger.error({ err: error, key }, 'stored file could not be removed');
        }
    }
}
