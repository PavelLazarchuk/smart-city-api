import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { CategoriesService } from '../src/modules/categories/categories.service';
import { NewsService } from '../src/modules/news/news.service';
import { OrganizationsService } from '../src/modules/organizations/organizations.service';
import { ServicesService } from '../src/modules/services/services.service';
import { UsersService } from '../src/modules/users/users.service';

const LOAD = {
    organization: {
        main_label: 'Load Test Org',
        main_category: 'healthcare',
        main_image: 'https://example.com/images/load.jpg',
    },
    bookableLabel: 'Load bookable service',
    center: { lat: 52.52, lng: 13.405 },
    password: 'Load-Test-Pass1',
    phonePrefix: '49170',
    users: Number(process.env['LOAD_USERS'] ?? 200),
    services: Number(process.env['LOAD_SERVICES'] ?? 50),
    news: Number(process.env['LOAD_NEWS'] ?? 30),
    bookableDays: [5, 6, 7],
};

function dateIn(days: number): string {
    const date = new Date();
    date.setDate(date.getDate() + days);

    return date.toISOString().slice(0, 10);
}

function halfHours(from: number, to: number): { time: string; limit: null }[] {
    const times: { time: string; limit: null }[] = [];

    for (let minutes = from * 60; minutes < to * 60; minutes += 30) {
        const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
        const mm = String(minutes % 60).padStart(2, '0');
        times.push({ time: `${hh}:${mm}`, limit: null });
    }

    return times;
}

function phoneOf(index: number): string {
    return `${LOAD.phonePrefix}${String(index).padStart(7, '0')}`;
}

async function main(): Promise<void> {
    if (process.env['NODE_ENV'] === 'production') {
        throw new Error('seed-load refuses to run with NODE_ENV=production');
    }

    process.env['JOBS_ENABLED'] = 'false';
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });

    try {
        const users = app.get(UsersService);
        const organizations = app.get(OrganizationsService);
        const categories = app.get(CategoriesService);
        const services = app.get(ServicesService);
        const news = app.get(NewsService);

        const existing = (
            await organizations.list(
                { main_category: LOAD.organization.main_category, include: [], limit: 100 },
                undefined,
            )
        ).items.find((item) => item.main_label === LOAD.organization.main_label);

        if (existing) {
            console.log(`organization: ${existing._id.toHexString()} (exists, catalogue left as is)`);
        } else {
            const organization = await organizations.create(LOAD.organization);
            const organizationId = organization._id.toHexString();
            console.log(`organization: ${organizationId}`);

            const category = await categories.create({
                organization_id: organizationId,
                label: 'Load',
                enabled: true,
            });
            const categoryId = category._id.toHexString();

            const bookable = await services.create({
                organization_id: organizationId,
                category_id: categoryId,
                label: LOAD.bookableLabel,
                enabled: true,
                location: LOAD.center,
                value: { heading_value: LOAD.bookableLabel, subscribe: 'load@example.com' },
                options: [
                    {
                        label: 'Book a time',
                        service_type: 'service_apply',
                        enabled: true,
                        slots: LOAD.bookableDays.map((days) => ({
                            child_type: 'date_time' as const,
                            value: { date: dateIn(days), time: halfHours(8, 20) },
                        })),
                    },
                ],
            });
            console.log(`bookable service: ${bookable._id.toHexString()}`);

            for (let i = 0; i < LOAD.services; i++) {
                await services.create({
                    organization_id: organizationId,
                    category_id: categoryId,
                    label: `Load service ${i + 1}`,
                    enabled: true,
                    tags: [i % 2 === 0 ? 'even' : 'odd'],
                    location: {
                        lat: LOAD.center.lat + ((i % 10) - 5) * 0.005,
                        lng: LOAD.center.lng + (Math.floor(i / 10) - 2) * 0.005,
                    },
                    value: { heading_value: `Load service ${i + 1}`, subscribe: 'load@example.com' },
                    options: [
                        {
                            label: 'Book a time',
                            service_type: 'service_apply',
                            enabled: true,
                            recurrent_dates: [{ day: 'monday', time: [{ time: '09:00', limit: 5 }] }],
                        },
                    ],
                });
            }

            for (let i = 0; i < LOAD.news; i++) {
                await news.create({
                    organization_id: organizationId,
                    label: `Load news ${i + 1}`,
                    enabled: true,
                    is_main: i === 0,
                    value: { heading_value: `Load news ${i + 1}`, text_value: 'Load test content.' },
                });
            }

            console.log(`catalogue: ${LOAD.services + 1} services, ${LOAD.news} news`);
        }

        let created = 0;

        for (let i = 0; i < LOAD.users; i++) {
            const phone = phoneOf(i);

            if (await users.findByPhone(phone)) continue;

            await users.createClient({ phone, name: `Load User ${i}`, password: LOAD.password });
            created++;
        }

        console.log(
            `users: ${LOAD.users} (${created} new), phones ${phoneOf(0)}..${phoneOf(LOAD.users - 1)}`,
        );
        console.log('seed-load complete');
    } finally {
        await app.close();
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
