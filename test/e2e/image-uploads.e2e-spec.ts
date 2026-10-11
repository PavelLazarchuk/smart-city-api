import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Types } from 'mongoose';
import sharp from 'sharp';

import { SettingsService } from '../../src/common/settings/settings.service';
import { ImagesRepository } from '../../src/modules/images/images.repository';
import { expectError } from '../support/assertions';
import { Fixtures } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('image uploads by type (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let superBearer: string;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        jest.restoreAllMocks();
        await t.app.get(SettingsService).refresh();
        organization = await fx.organization();
        superBearer = await fx.bearer(await fx.superAdmin());
    });

    const allow = (mimes: string[]) =>
        t.http
            .patch(`${t.prefix}/settings`)
            .set('Authorization', superBearer)
            .send({ values: { 'upload.allowed_mime': mimes } });

    const upload = (bytes: Buffer, contentType: string, organizationId = organization.id) =>
        t.http
            .post(`${t.prefix}/organizations/${organizationId}/images`)
            .set('Authorization', superBearer)
            .attach('file', bytes, { filename: 'file', contentType });

    const square = () => sharp({ create: { width: 16, height: 12, channels: 3, background: '#aa3311' } });

    it('stores WebP and GIF once they are allowed and keeps their format', async () => {
        const webp = await square().webp().toBuffer();
        const gif = await square().gif().toBuffer();

        expectError(await upload(webp, 'image/webp'), 400, 'FILE_TYPE_NOT_ALLOWED');
        expect((await allow(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])).status).toBe(200);

        for (const [bytes, mime, extension, format] of [
            [webp, 'image/webp', '.webp', 'webp'],
            [gif, 'image/gif', '.gif', 'gif'],
        ] as const) {
            const res = await upload(bytes, mime);
            expect(res.status).toBe(201);
            expect(res.body.data.mime_type).toBe(mime);
            expect((res.body.data.name as string).endsWith(extension)).toBe(true);
            const stored = await sharp(
                join(t.config.storage.local.dir, res.body.data.name as string),
            ).metadata();
            expect(stored.format).toBe(format);
            expect(stored.width).toBe(16);
        }
    });

    it('refuses bytes that do not match the declared type', async () => {
        await allow(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
        const png = await square().png().toBuffer();

        expectError(await upload(png, 'image/jpeg'), 400, 'FILE_TYPE_NOT_ALLOWED');
        expectError(await upload(png, 'image/webp'), 400, 'FILE_TYPE_NOT_ALLOWED');
        expectError(await upload(png, 'image/gif'), 400, 'FILE_TYPE_NOT_ALLOWED');
        expectError(await upload(Buffer.from('RIFF'), 'image/webp'), 400, 'FILE_TYPE_NOT_ALLOWED');
    });

    it('refuses an upload for an organization that does not exist', async () => {
        const png = await square().png().toBuffer();

        expectError(await upload(png, 'image/png', new Types.ObjectId().toHexString()), 404);
    });

    it('removes the stored file again when the row cannot be written', async () => {
        jest.spyOn(t.app.get(ImagesRepository), 'create').mockRejectedValueOnce(new Error('db down'));
        const png = await square().png().toBuffer();

        expect((await upload(png, 'image/png')).status).toBe(500);
        expect(await fx.collection('Image').countDocuments({})).toBe(0);
        const dir = join(t.config.storage.local.dir, organization.id);
        expect(existsSync(dir) ? await readdir(dir) : []).toEqual([]);
    });

    it('lists images by organization and answers 404 for an unknown one on delete', async () => {
        const other = await fx.organization();
        const own = await fx.image(organization.id);
        await fx.image(other.id);

        const res = await t.http
            .get(`${t.prefix}/images?organization_id=${organization.id}`)
            .set('Authorization', superBearer);
        expect(res.body.data.map((row: { id: string }) => row.id)).toEqual([own.id]);
        expectError(
            await t.http
                .delete(`${t.prefix}/images/${new Types.ObjectId().toHexString()}`)
                .set('Authorization', superBearer),
            404,
        );
    });
});
