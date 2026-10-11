import * as smpp from 'smpp';

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
