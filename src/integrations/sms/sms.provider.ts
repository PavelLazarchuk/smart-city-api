export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

export interface SmsProvider {
    readonly name: string;
    send(phone: string, text: string): Promise<void>;
}
