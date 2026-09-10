declare module 'smpp' {
    interface Pdu {
        command_status: number;
        [key: string]: unknown;
    }
    interface Session {
        bind_transceiver(params: Record<string, unknown>, callback: (pdu: Pdu) => void): void;
        submit_sm(params: Record<string, unknown>, callback: (pdu: Pdu) => void): void;
        unbind(): void;
        close(): void;
        on(event: 'error', listener: (error: Error) => void): void;
        on(event: 'close', listener: () => void): void;
    }
    export function connect(url: string, callback?: () => void): Session;
}
