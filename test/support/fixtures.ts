import { type INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { type Model, Types } from 'mongoose';

import { type Role, ROLES } from '../../src/common/decorators/roles.decorator';
import { PasswordService } from '../../src/modules/auth/password.service';
import { Session } from '../../src/modules/auth/schemas/session.schema';
import { TokenService } from '../../src/modules/auth/token.service';
import { Category } from '../../src/modules/categories/schemas/category.schema';
import { Image } from '../../src/modules/images/schemas/image.schema';
import { InfoSection } from '../../src/modules/infosections/schemas/infosection.schema';
import { News } from '../../src/modules/news/schemas/news.schema';
import { Organization } from '../../src/modules/organizations/schemas/organization.schema';
import { Booking } from '../../src/modules/bookings/schemas/booking.schema';
import { Service, type ServiceOption } from '../../src/modules/services/schemas/service.schema';
import { User } from '../../src/modules/users/schemas/user.schema';

let counter = 0;
const next = (): number => (counter += 1);

export interface FixtureUser {
    id: string;
    role: Role;
    login?: string;
    phone?: string;
    password?: string;
    name?: string;
    organization_ids: string[];
}

export class Fixtures {
    constructor(private readonly app: INestApplication) {}

    private model<T>(name: string): Model<T> {
        return this.app.get<Model<T>>(getModelToken(name));
    }

    async user(
        overrides: Partial<{
            role: Role;
            login: string;
            phone: string;
            password: string;
            name: string;
            organization_ids: string[];
        }> = {},
    ): Promise<FixtureUser> {
        const role = overrides.role ?? ROLES.COMMON_USER;
        const n = next();
        const isAdmin = role !== ROLES.COMMON_USER;
        const login = overrides.login ?? (isAdmin ? `admin_${n}_${randomUUID().slice(0, 6)}` : undefined);
        const phone = overrides.phone ?? (isAdmin ? undefined : `37529${String(1000000 + n).slice(-7)}`);
        const password = overrides.password ?? (isAdmin ? 'Password-123' : undefined);
        const passwords = this.app.get(PasswordService);
        const doc = await this.model<User>(User.name).create({
            role,
            login,
            phone,
            name: overrides.name ?? `User ${n}`,
            password_hash: password ? await passwords.hash(password) : undefined,
            organization_ids: (overrides.organization_ids ?? []).map((id) => new Types.ObjectId(id)),
        });

        return {
            id: doc._id.toHexString(),
            role,
            login,
            phone,
            password,
            name: doc.name,
            organization_ids: overrides.organization_ids ?? [],
        };
    }

    superAdmin(): Promise<FixtureUser> {
        return this.user({ role: ROLES.SUPER_ADMIN });
    }

    admin(organizationIds: string[]): Promise<FixtureUser> {
        return this.user({ role: ROLES.COMMON_ADMIN, organization_ids: organizationIds });
    }

    citizen(
        overrides: Partial<{ phone: string; name: string; password: string }> = {},
    ): Promise<FixtureUser> {
        return this.user({ role: ROLES.COMMON_USER, ...overrides });
    }

    async token(user: FixtureUser): Promise<{ access: string; refresh: string; sid: string }> {
        const tokens = this.app.get(TokenService);
        const sid = new Types.ObjectId();
        const pair = await tokens.issuePair({ id: user.id, role: user.role }, sid.toHexString());
        await this.model<Session>(Session.name).create({
            _id: sid,
            user_id: new Types.ObjectId(user.id),
            family_id: sid,
            refresh_token_hash: tokens.hashRefreshToken(pair.refresh_token),
            expires_at: pair.refresh_expires_at,
        });

        return { access: pair.access_token, refresh: pair.refresh_token, sid: sid.toHexString() };
    }

    async bearer(user: FixtureUser): Promise<string> {
        const { access } = await this.token(user);

        return `Bearer ${access}`;
    }

    async organization(overrides: Partial<Organization> = {}): Promise<{ id: string; main_label: string }> {
        const n = next();
        const doc = await this.model<Organization>(Organization.name).create({
            main_label: `Organization ${n}`,
            main_category: 'healthcare',
            main_image: 'https://example.com/image.jpg',
            ...overrides,
        });

        return { id: doc._id.toHexString(), main_label: doc.main_label };
    }

    async category(organizationId: string, overrides: Partial<Category> = {}): Promise<{ id: string }> {
        const doc = await this.model<Category>(Category.name).create({
            organization_id: new Types.ObjectId(organizationId),
            position: overrides.position ?? next(),
            label: `Category ${counter}`,
            enabled: true,
            ...overrides,
        });

        return { id: doc._id.toHexString() };
    }

    async service(
        organizationId: string,
        overrides: Partial<Omit<Service, 'organization_id' | 'category_id'>> & {
            category_id?: string | null;
        } = {},
    ): Promise<{ id: string }> {
        const { category_id: categoryId, ...rest } = overrides;
        const doc = await this.model<Service>(Service.name).create({
            organization_id: new Types.ObjectId(organizationId),
            category_id: categoryId ? new Types.ObjectId(categoryId) : null,
            position: rest.position ?? next(),
            label: `Service ${counter}`,
            enabled: true,
            value: { heading_value: `Service ${counter}` },
            options: [],
            ...rest,
        });

        return { id: doc._id.toHexString() };
    }

    bookableOption(limit: number | null = 2, time = '10:00'): ServiceOption & { slot_id: string } {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const date = tomorrow.toISOString().slice(0, 10);
        const slotId = randomUUID();

        return {
            id: randomUUID(),
            label: 'Booking',
            service_type: 'service_apply',
            enabled: true,
            slots: [
                {
                    id: slotId,
                    label: 'Date',
                    child_type: 'date_time',
                    value: { date, time: [{ time, limit, booked_count: 0 }] },
                },
            ],
            slot_id: slotId,
        };
    }

    /**
     * Seeds a booking the way the API does: a row in `bookings` plus the slot's occupancy counter.
     */
    async booking(params: {
        service_id: string;
        organization_id: string;
        option_id: string;
        slot_id: string;
        user_id: string;
        time?: string;
        child_type?: string;
        person?: string;
        phone?: string;
        info?: string;
    }): Promise<{ id: string }> {
        const id = randomUUID();
        await this.model<Booking>(Booking.name).create({
            id,
            service_id: new Types.ObjectId(params.service_id),
            organization_id: new Types.ObjectId(params.organization_id),
            option_id: params.option_id,
            slot_id: params.slot_id,
            child_type: params.child_type ?? (params.time ? 'date_time' : 'apply'),
            slot_date: null,
            slot_time: params.time ?? null,
            service_label: 'Service',
            user_id: new Types.ObjectId(params.user_id),
            person: params.person ?? 'Person',
            phone: params.phone ?? '375290000000',
            info: params.info ?? '',
        });
        const counter = params.time
            ? { 'options.$[option].slots.$[slot].value.time.$[entry].booked_count': 1 }
            : { 'options.$[option].slots.$[slot].value.booked_count': 1 };
        const arrayFilters: Record<string, unknown>[] = [
            { 'option.id': params.option_id },
            { 'slot.id': params.slot_id },
        ];

        if (params.time) arrayFilters.push({ 'entry.time': params.time });

        await this.model<Service>(Service.name)
            .updateOne({ _id: params.service_id }, { $inc: counter }, { arrayFilters })
            .exec();

        return { id };
    }

    async news(organizationId: string, overrides: Partial<News> = {}): Promise<{ id: string }> {
        const doc = await this.model<News>(News.name).create({
            organization_id: new Types.ObjectId(organizationId),
            position: overrides.position ?? next(),
            label: `News ${counter}`,
            enabled: true,
            date: new Date(),
            is_main: false,
            is_offer: false,
            value: { heading_value: `News ${counter}` },
            ...overrides,
        });

        return { id: doc._id.toHexString() };
    }

    async infoSection(organizationId: string, overrides: Partial<InfoSection> = {}): Promise<{ id: string }> {
        const doc = await this.model<InfoSection>(InfoSection.name).create({
            organization_id: new Types.ObjectId(organizationId),
            position: overrides.position ?? next(),
            label: `Info ${counter}`,
            enabled: true,
            control: 'text',
            value: { text_value: 'Some text' },
            ...overrides,
        });

        return { id: doc._id.toHexString() };
    }

    /** An uploaded image row. `name` is the storage key, `src` the URL documents refer to. */
    async image(
        organizationId: string,
        overrides: Partial<Image> = {},
    ): Promise<{ id: string; name: string; src: string }> {
        const key = overrides.name ?? `${organizationId}/${randomUUID()}.jpg`;
        const doc = await this.model<Image>(Image.name).create({
            organization_id: new Types.ObjectId(organizationId),
            mime_type: 'image/jpeg',
            size: 1024,
            ...overrides,
            name: key,
            src: overrides.src ?? `http://localhost:8080/uploads/${key}`,
        });

        return { id: doc._id.toHexString(), name: doc.name, src: doc.src };
    }

    collection<T>(name: string): Model<T> {
        return this.model<T>(name);
    }
}
