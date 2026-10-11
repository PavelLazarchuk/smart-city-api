import { type AuthUser } from '../../common/decorators/current-user.decorator';
import { type Role } from '../../common/decorators/roles.decorator';
import { ServicesMasker, type ServiceView } from './services.masker';

const viewer = (role: Role, organizationIds: string[] = []): AuthUser => ({
    id: 'u1',
    role,
    organization_ids: organizationIds,
    sid: 's1',
});

const service = (): ServiceView & { label: string } => ({
    _id: 'svc',
    organization_id: 'org1',
    label: 'Massage',
    value: { subscribe: 'owner@example.com' },
    options: [
        {
            slots: [
                {
                    child_type: 'date_time',
                    value: {
                        time: [
                            { booked_count: 2, bookings: [{ person: 'Anna' }, { person: 'Bob' }] },
                            { booked_count: 0 },
                        ],
                    },
                },
                { child_type: 'callback', value: { time: [{ booked_count: 1 }] } },
                { child_type: 'date', value: { booked_count: 3, bookings: [{ person: 'Eve' }] } },
                { child_type: 'apply', value: {} },
                { child_type: 'apply' },
            ],
        },
        {},
    ],
});

describe('ServicesMasker', () => {
    const masker = new ServicesMasker();

    it('lets every signed-in staff role ask for details but never a client or a guest', () => {
        expect(masker.maySeeDetails(undefined)).toBe(false);
        expect(masker.maySeeDetails(viewer('common-user'))).toBe(false);
        expect(masker.maySeeDetails(viewer('operator'))).toBe(true);
        expect(masker.maySeeDetails(viewer('common-admin'))).toBe(true);
        expect(masker.maySeeDetails(viewer('super-admin'))).toBe(true);
    });

    it('shows details only to the staff of the owning organization and to super-admins', () => {
        expect(masker.canSeeDetails(viewer('super-admin'), 'org1')).toBe(true);
        expect(masker.canSeeDetails(viewer('common-admin', ['org1']), 'org1')).toBe(true);
        expect(masker.canSeeDetails(viewer('operator', ['org1']), 'org1')).toBe(true);
        expect(masker.canSeeDetails(viewer('common-admin', ['org2']), 'org1')).toBe(false);
        expect(masker.canSeeDetails(viewer('common-user', ['org1']), 'org1')).toBe(false);
        expect(masker.canSeeDetails(undefined, 'org1')).toBe(false);
    });

    it('returns the service untouched to its own staff', () => {
        const original = service();

        expect(masker.mask(original, viewer('common-admin', ['org1']))).toBe(original);
    });

    it('replaces bookings with reserved markers rebuilt from the counters and drops subscribe', () => {
        const masked = masker.mask(service(), viewer('common-user'));
        const [first, second] = masked.options!;
        const [timed, callback, dated, apply, empty] = first!.slots!;

        expect(masked.value).toEqual({});
        expect(masked.label).toBe('Massage');
        expect(timed!.value!.time).toEqual([
            { booked_count: 2, bookings: [{ status: 'reserved' }, { status: 'reserved' }] },
            { booked_count: 0, bookings: [] },
        ]);
        expect(callback!.value!.time).toEqual([{ booked_count: 1, bookings: [{ status: 'reserved' }] }]);
        expect(dated!.value!.bookings).toHaveLength(3);
        expect(JSON.stringify(masked)).not.toContain('Eve');
        expect(apply!.value).toEqual({ bookings: [] });
        expect(empty!.value).toBeUndefined();
        expect(second!.slots).toEqual([]);
    });

    it('masks against an explicit organization when one is given', () => {
        const original = service();

        expect(masker.mask(original, viewer('common-admin', ['org9']), 'org9')).toBe(original);
        expect(masker.mask(original, viewer('common-admin', ['org1']), 'org9')).not.toBe(original);
    });

    it('copes with a service without value and options', () => {
        const masked = masker.maskCounts({ _id: 'x', organization_id: 'org1' });

        expect(masked).toEqual({ _id: 'x', organization_id: 'org1', value: {}, options: [] });
    });

    it('never answers negative marker counts', () => {
        const masked = masker.maskCounts({
            _id: 'x',
            organization_id: 'org1',
            options: [{ slots: [{ child_type: 'date', value: { booked_count: -4 } }] }],
        });

        expect((masked.options[0]!.slots[0]!.value as unknown as { bookings: unknown[] }).bookings).toEqual(
            [],
        );
    });
});
