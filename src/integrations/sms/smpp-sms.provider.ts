import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import * as smpp from 'smpp';

import { AppConfig } from '../../common/config/app-config';
import { type SmsProvider } from './sms.provider';
import { splitSms } from './sms-segments';

const DATA_CODING = { gsm: 0x01, ucs2: 0x08 } as const;
const UDH_INDICATOR = 0x40;

@Injectable()
export class SmppSmsProvider implements SmsProvider {
    readonly name = 'smpp';

    constructor(private readonly config: AppConfig) {}

    send(phone: string, text: string): Promise<void> {
        const { url, systemId, password, sourceAddr } = this.config.sms.smpp;
        const { encoding, parts } = splitSms(text);
        const reference = randomInt(0, 256);
        const base = {
            dest_addr_ton: 1,
            dest_addr_npi: 1,
            source_addr_ton: 5,
            source_addr_npi: 0,
            source_addr: sourceAddr,
            destination_addr: phone,
            data_coding: DATA_CODING[encoding],
        };
        const pdus = parts.map((message, index) =>
            parts.length === 1
                ? { ...base, short_message: message }
                : {
                      ...base,
                      esm_class: UDH_INDICATOR,
                      short_message: {
                          udh: Buffer.from([0x05, 0x00, 0x03, reference, parts.length, index + 1]),
                          message,
                      },
                  },
        );

        return new Promise<void>((resolve, reject) => {
            const session = smpp.connect(url ?? '');
            let settled = false;
            const finish = (error?: Error): void => {
                if (settled) return;

                settled = true;
                try {
                    session.close();
                } catch {
                    // The session is being abandoned either way; a failed close changes nothing.
                }

                if (error) reject(error);
                else resolve();
            };
            const submit = (index: number): void => {
                const pdu = pdus[index];

                if (!pdu) return finish();

                try {
                    session.submit_sm(
                        pdu,
                        (result) => {
                            if (result.command_status !== 0)
                                return finish(new Error(`SMPP submit failed: ${result.command_status}`));

                            submit(index + 1);
                        },
                        undefined,
                        (failed) => finish(new Error(`SMPP submit failed: ${failed.command_status}`)),
                    );
                } catch (error) {
                    finish(error instanceof Error ? error : new Error(String(error)));
                }
            };
            session.on('error', (error) => finish(error));
            session.bind_transceiver({ system_id: systemId, password }, (pdu) => {
                if (pdu.command_status !== 0)
                    return finish(new Error(`SMPP bind failed: ${pdu.command_status}`));

                submit(0);
            });
        });
    }
}
