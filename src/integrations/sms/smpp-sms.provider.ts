import { Injectable } from '@nestjs/common';
import * as smpp from 'smpp';

import { AppConfig } from '../../common/config/app-config';
import { type SmsProvider } from './sms.provider';

@Injectable()
export class SmppSmsProvider implements SmsProvider {
    readonly name = 'smpp';

    constructor(private readonly config: AppConfig) {}

    send(phone: string, text: string): Promise<void> {
        const { url, systemId, password, sourceAddr } = this.config.sms.smpp;

        return new Promise<void>((resolve, reject) => {
            const session = smpp.connect(url ?? '');
            let settled = false;
            const finish = (error?: Error): void => {
                if (settled) return;

                settled = true;
                try {
                    session.close();
                } catch {
                    // empty
                }

                if (error) reject(error);
                else resolve();
            };
            session.on('error', (error) => finish(error));
            session.bind_transceiver({ system_id: systemId, password }, (pdu) => {
                if (pdu.command_status !== 0)
                    return finish(new Error(`SMPP bind failed: ${pdu.command_status}`));

                session.submit_sm(
                    {
                        dest_addr_ton: 1,
                        dest_addr_npi: 1,
                        source_addr_ton: 5,
                        source_addr_npi: 0,
                        short_message: text,
                        source_addr: sourceAddr,
                        destination_addr: phone,
                    },
                    (result) => {
                        if (result.command_status !== 0)
                            return finish(new Error(`SMPP submit failed: ${result.command_status}`));

                        finish();
                    },
                );
            });
        });
    }
}
