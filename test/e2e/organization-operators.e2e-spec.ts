import { Types } from 'mongoose';

import { AppConfig } from '../../src/common/config/app-config';
import { expectError } from '../support/assertions';
import { Fixtures, type FixtureUser } from '../support/fixtures';
import { createTestApp, type TestApp } from '../support/test-app';

describe('organization operators (e2e)', () => {
    let t: TestApp;
    let fx: Fixtures;
    let organization: { id: string };
    let admin: FixtureUser;
    let adminBearer: string;

    beforeAll(async () => {
        t = await createTestApp();
        fx = new Fixtures(t.app);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
        await t.clearDatabase();
        t.app.get(AppConfig).auth.adminLoginMethod = 'password';
        organization = await fx.organization();
        admin = await fx.admin([organization.id]);
        adminBearer = await fx.bearer(admin);
    });

    const path = (organizationId = organization.id) =>
        `${t.prefix}/organizations/${organizationId}/operators`;
    const login = (loginName: string, password: string) =>
        t.http.post(`${t.prefix}/auth/login`).send({ login: loginName, password });
    const createOperator = async (loginName = 'desk_one') => {
        const res = await t.http
            .post(path())
            .set('Authorization', adminBearer)
            .send({ login: loginName, password: 'Issued-Pass-1', name: 'Desk' });
        expect(res.status).toBe(201);

        return res.body.data as { id: string; role: string; password_change_required: boolean };
    };

    it('lets an organization admin create an operator who must change the issued password first', async () => {
        const operator = await createOperator();
        expect(operator).toMatchObject({
            role: 'operator',
            password_change_required: true,
            organization_ids: [organization.id],
        });

        const signedIn = await login('desk_one', 'Issued-Pass-1');
        expect(signedIn.status).toBe(200);
        expect(signedIn.body.data.user.password_change_required).toBe(true);
        const bearer = `Bearer ${signedIn.body.data.access_token as string}`;

        expectError(
            await t.http.get(`${t.prefix}/bookings`).set('Authorization', bearer),
            403,
            'PASSWORD_CHANGE_REQUIRED',
        );
        expect((await t.http.get(`${t.prefix}/auth/me`).set('Authorization', bearer)).status).toBe(200);

        const changed = await t.http.patch(`${t.prefix}/auth/password`).set('Authorization', bearer).send({
            current_password: 'Issued-Pass-1',
            new_password: 'Own-Secret-22',
            new_password_confirmation: 'Own-Secret-22',
        });
        expect(changed.status).toBe(204);
        expect((await t.http.get(`${t.prefix}/bookings`).set('Authorization', bearer)).status).toBe(200);
        expect((await login('desk_one', 'Own-Secret-22')).body.data.user.password_change_required).toBe(
            false,
        );
    });

    it('lists, resets and removes only the operators of its own organization', async () => {
        const operator = await createOperator();
        const other = await fx.organization();
        const foreign = await fx.user({ role: 'operator', organization_ids: [other.id] });

        const listed = await t.http.get(path()).set('Authorization', adminBearer);
        expect(listed.body.data.map((row: { id: string }) => row.id)).toEqual([operator.id]);

        await t.http
            .patch(`${t.prefix}/auth/password`)
            .set(
                'Authorization',
                `Bearer ${(await login('desk_one', 'Issued-Pass-1')).body.data.access_token as string}`,
            )
            .send({
                current_password: 'Issued-Pass-1',
                new_password: 'Own-Secret-22',
                new_password_confirmation: 'Own-Secret-22',
            });
        const reset = await t.http
            .patch(`${path()}/${operator.id}`)
            .set('Authorization', adminBearer)
            .send({ password: 'Reset-Pass-33', name: 'Front desk' });
        expect(reset.status).toBe(200);
        expect(reset.body.data).toMatchObject({ name: 'Front desk', password_change_required: true });

        expectError(
            await t.http
                .patch(`${path()}/${foreign.id}`)
                .set('Authorization', adminBearer)
                .send({ name: 'x' }),
            404,
            'USER_NOT_FOUND',
        );
        expectError(
            await t.http.patch(`${path()}/${admin.id}`).set('Authorization', adminBearer).send({ name: 'x' }),
            404,
            'USER_NOT_FOUND',
        );
        expectError(await t.http.get(path(other.id)).set('Authorization', adminBearer), 404);
        expectError(
            await t.http.get(path()).set('Authorization', await fx.bearer(foreign)),
            403,
            'FORBIDDEN',
        );

        expect(
            (await t.http.delete(`${path()}/${operator.id}`).set('Authorization', adminBearer)).status,
        ).toBe(204);
        expect(await fx.collection('User').countDocuments({ _id: new Types.ObjectId(operator.id) })).toBe(0);
    });

    it('only detaches an operator who also works for another organization', async () => {
        const other = await fx.organization();
        const shared = await fx.user({ role: 'operator', organization_ids: [organization.id, other.id] });

        expect((await t.http.delete(`${path()}/${shared.id}`).set('Authorization', adminBearer)).status).toBe(
            204,
        );
        const row = await fx
            .collection<{ organization_ids: Types.ObjectId[] }>('User')
            .findById(shared.id)
            .lean();
        expect(row!.organization_ids.map((id) => id.toHexString())).toEqual([other.id]);
    });

    it('documents PASSWORD_CHANGE_REQUIRED on every bearer route except the ones left open for the change', async () => {
        const docs = await t.http.get('/api/docs-json');
        const forbidden = (path: string, method: string): string =>
            JSON.stringify(docs.body.paths[`${t.prefix}${path}`][method].responses['403'] ?? {});

        expect(forbidden('/bookings', 'get')).toContain('PASSWORD_CHANGE_REQUIRED');
        expect(forbidden('/auth/me', 'get')).not.toContain('PASSWORD_CHANGE_REQUIRED');
        expect(forbidden('/auth/password', 'patch')).not.toContain('PASSWORD_CHANGE_REQUIRED');
    });
});
