export const VIBER_PROVIDER = Symbol('VIBER_PROVIDER');

export interface ViberMessage {
    phone: string;
    text: string;
    fallbackSms: string | null;
}

export interface ViberProvider {
    readonly name: string;
    send(message: ViberMessage): Promise<void>;
}
