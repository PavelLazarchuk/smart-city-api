import * as smpp from 'smpp';

const { PDU } = jest.requireActual<{
    PDU: new (command: string, params: Record<string, unknown>) => { toBuffer(): Buffer };
}>('smpp');

import { type AppConfig } from '../../common/config/app-config';
import { SmppSmsProvider } from './smpp-sms.provider';

jest.mock('smpp', () => ({ connect: jest.fn() }));

interface FakeSession {
    bindStatus: number;
    submitStatus: number;
    closeThrows: boolean;
    submitted: Record<string, unknown>[];
    bound: Record<string, unknown>[];
    closed: number;
    errorListener?: (error: Error) => void;
}

function fakeSession(overrides: Partial<FakeSession> = {}): FakeSession {
    const state: FakeSession = {
        bindStatus: 0,
        submitStatus: 0,
        closeThrows: false,
        submitted: [],
        bound: [],
        closed: 0,
        ...overrides,
    };
    (smpp.connect as jest.Mock).mockReturnValue({
        on: (_event: string, listener: (error: Error) => void) => {
            state.errorListener = listener;
        },
        bind_transceiver: (
            params: Record<string, unknown>,
            callback: (pdu: { command_status: number }) => void,
        ) => {
            state.bound.push(params);
            callback({ command_status: state.bindStatus });
        },
        submit_sm: (params: Record<string, unknown>, callback: (pdu: { command_status: number }) => void) => {
            state.submitted.push(params);
            new PDU('submit_sm', params).toBuffer();
            callback({ command_status: state.submitStatus });
        },
        close: () => {
            state.closed += 1;

            if (state.closeThrows) throw new Error('already closed');
        },
    });

    return state;
}

const provider = (url?: string) =>
    new SmppSmsProvider({
        sms: { smpp: { url, systemId: 'city', password: 'secret', sourceAddr: 'CITY' } },
    } as unknown as AppConfig);

describe('SmppSmsProvider', () => {
    afterEach(() => jest.clearAllMocks());

    it('binds, submits the text to the phone and closes the session', async () => {
        const session = fakeSession();

        await expect(provider('smpp://gateway:2775').send('4915290000000', 'Hello')).resolves.toBeUndefined();

        expect(smpp.connect).toHaveBeenCalledWith('smpp://gateway:2775');
        expect(session.bound).toEqual([{ system_id: 'city', password: 'secret' }]);
        expect(session.submitted[0]).toMatchObject({
            destination_addr: '4915290000000',
            short_message: 'Hello',
            source_addr: 'CITY',
        });
        expect(session.closed).toBe(1);
    });

    it('rejects when the bind is refused, without submitting', async () => {
        const session = fakeSession({ bindStatus: 13 });

        await expect(provider().send('4915290000000', 'Hello')).rejects.toThrow('SMPP bind failed: 13');
        expect(session.submitted).toEqual([]);
        expect(smpp.connect).toHaveBeenCalledWith('');
    });

    it('rejects when the gateway refuses the message', async () => {
        fakeSession({ submitStatus: 88 });

        await expect(provider('smpp://x').send('4915290000000', 'Hello')).rejects.toThrow(
            'SMPP submit failed: 88',
        );
    });

    it('settles once even if the session errors after the answer and its close throws', async () => {
        const session = fakeSession({ closeThrows: true });

        await expect(provider('smpp://x').send('4915290000000', 'Hello')).resolves.toBeUndefined();
        session.errorListener!(new Error('socket reset'));
        expect(session.closed).toBe(1);
    });

    it('sends a long Ukrainian text as concatenated UCS-2 parts', async () => {
        const session = fakeSession();
        const text = `Запис скасовано. Причина: ${'перенесення прийому, '.repeat(10)}`;

        await expect(provider('smpp://x').send('380501234567', text)).resolves.toBeUndefined();

        expect(session.submitted).toHaveLength(4);
        session.submitted.forEach((params, index) => {
            const message = params['short_message'] as { udh: Buffer; message: string };

            expect(params).toMatchObject({ esm_class: 0x40, data_coding: 0x08 });
            expect([...message.udh.subarray(0, 3)]).toEqual([0x05, 0x00, 0x03]);
            expect(message.udh[4]).toBe(4);
            expect(message.udh[5]).toBe(index + 1);
        });
        const references = session.submitted.map(
            (params) => (params['short_message'] as { udh: Buffer }).udh[3],
        );

        expect(new Set(references).size).toBe(1);
        expect(
            session.submitted
                .map((params) => (params['short_message'] as { message: string }).message)
                .join(''),
        ).toBe(text);
    });

    it('rejects instead of crashing when the PDU cannot be built', async () => {
        const session = fakeSession();
        (smpp.connect as jest.Mock).mockReturnValueOnce({
            on: () => undefined,
            bind_transceiver: (_: unknown, callback: (pdu: { command_status: number }) => void) =>
                callback({ command_status: 0 }),
            submit_sm: () => {
                throw new RangeError('out of range');
            },
            close: () => {
                session.closed += 1;
            },
        });

        await expect(provider('smpp://x').send('380501234567', 'Hello')).rejects.toThrow('out of range');
        expect(session.closed).toBe(1);
    });

    it('rejects when the socket is not writable', async () => {
        fakeSession();
        (smpp.connect as jest.Mock).mockReturnValueOnce({
            on: () => undefined,
            bind_transceiver: (_: unknown, callback: (pdu: { command_status: number }) => void) =>
                callback({ command_status: 0 }),
            submit_sm: (
                _params: unknown,
                _callback: unknown,
                _sent: unknown,
                failure: (pdu: { command_status: number }) => void,
            ) => failure({ command_status: 69 }),
            close: () => undefined,
        });

        await expect(provider('smpp://x').send('380501234567', 'Hello')).rejects.toThrow(
            'SMPP submit failed: 69',
        );
    });

    it('rejects with the connection error', async () => {
        const session = fakeSession();
        (smpp.connect as jest.Mock).mockReturnValueOnce({
            on: (_event: string, listener: (error: Error) => void) => {
                session.errorListener = listener;
            },
            bind_transceiver: () => session.errorListener!(new Error('ECONNREFUSED')),
            close: () => undefined,
        });

        await expect(provider('smpp://x').send('4915290000000', 'Hello')).rejects.toThrow('ECONNREFUSED');
    });
});
