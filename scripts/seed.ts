import { NestFactory } from '@nestjs/core';
import { type Types } from 'mongoose';

import { AppModule } from '../src/app.module';
import { CategoriesService } from '../src/modules/categories/categories.service';
import { InfoSectionsService } from '../src/modules/infosections/infosections.service';
import { NewsService } from '../src/modules/news/news.service';
import { OrganizationsService } from '../src/modules/organizations/organizations.service';
import { ServicesService } from '../src/modules/services/services.service';
import { UsersService } from '../src/modules/users/users.service';

const SEED = {
    superAdmin: { login: 'superadmin', password: 'Superadmin-Pass1', name: 'Super Admin' },
    admin: { login: 'cityadmin', password: 'Cityadmin-Pass1', name: 'City Admin' },
    client: { phone: '4915290000001', name: 'Client One' },
    organization: {
        main_label: 'City Clinic No. 1',
        main_category: 'healthcare',
        main_image: 'https://example.com/images/clinic.jpg',
    },
};

async function main(): Promise<void> {
    if (process.env['NODE_ENV'] === 'production') {
        throw new Error('seed refuses to run with NODE_ENV=production');
    }

    process.env['JOBS_ENABLED'] = 'false';
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });

    try {
        const users = app.get(UsersService);
        const organizations = app.get(OrganizationsService);
        const categories = app.get(CategoriesService);
        const services = app.get(ServicesService);
        const news = app.get(NewsService);
        const infosections = app.get(InfoSectionsService);

        const superAdmin =
            (await users.findByLoginWithPassword(SEED.superAdmin.login)) ??
            (await users.create({ ...SEED.superAdmin, role: 'super-admin' }));

        console.log(`super-admin: ${superAdmin._id.toHexString()} (login ${SEED.superAdmin.login})`);

        const existingOrganization = (
            await organizations.list(
                { main_category: SEED.organization.main_category, include: [], limit: 100 },
                undefined,
            )
        ).items.find((item) => item.main_label === SEED.organization.main_label);
        const organization = existingOrganization ?? (await organizations.create(SEED.organization));
        console.log(`organization: ${organization._id.toHexString()}`);
        const organizationId = organization._id.toHexString();

        const admin =
            (await users.findByLoginWithPassword(SEED.admin.login)) ??
            (await users.create({ ...SEED.admin, role: 'common-admin', organization_ids: [organizationId] }));

        if (!admin.organization_ids.some((id: Types.ObjectId) => id.toHexString() === organizationId)) {
            await users.setOrganizations(admin._id.toHexString(), [
                ...admin.organization_ids.map((id: Types.ObjectId) => id.toHexString()),
                organizationId,
            ]);
        }

        console.log(`admin: ${admin._id.toHexString()} (login ${SEED.admin.login})`);

        const client =
            (await users.findByPhone(SEED.client.phone)) ?? (await users.createClient(SEED.client));
        console.log(`client: ${client._id.toHexString()} (phone ${SEED.client.phone})`);

        if (!existingOrganization) {
            const category = await categories.create({
                organization_id: organizationId,
                label: 'Appointments',
                enabled: true,
            });
            const inFuture = new Date();
            inFuture.setDate(inFuture.getDate() + 3);
            const date = inFuture.toISOString().slice(0, 10);
            await services.create({
                organization_id: organizationId,
                category_id: category._id.toHexString(),
                label: 'Therapist appointment',
                enabled: true,
                value: { heading_value: 'Therapist appointment', subscribe: 'clinic@example.com' },
                options: [
                    {
                        label: 'Book a time',
                        service_type: 'service_apply',
                        enabled: true,
                        recurrent_dates: [
                            {
                                day: 'monday',
                                time: [
                                    { time: '09:00', limit: 2 },
                                    { time: '10:00', limit: 2 },
                                ],
                            },
                        ],
                        slots: [
                            {
                                child_type: 'date_time',
                                value: {
                                    date,
                                    time: [
                                        { time: '09:00', limit: 2 },
                                        { time: '10:00', limit: 1 },
                                    ],
                                },
                            },
                        ],
                    },
                ],
            });
            await services.create({
                organization_id: organizationId,
                label: 'Home delivery of prescriptions',
                enabled: true,
                options: [
                    {
                        service_type: 'service_delivery',
                        slots: [{ child_type: 'delivery', value: { description: 'Same-day delivery' } }],
                    },
                ],
            });
            await news.create({
                organization_id: organizationId,
                label: 'Opening hours changed',
                enabled: true,
                is_main: true,
                value: { heading_value: 'Opening hours changed', text_value: 'We now open at 08:00.' },
            });
            await infosections.create({
                organization_id: organizationId,
                label: 'Address',
                enabled: true,
                control: 'address',
                value: { text: '1 Main Street', lat: '53.9', lng: '27.56' },
            });
        }

        console.log('seed complete');
    } finally {
        await app.close();
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
