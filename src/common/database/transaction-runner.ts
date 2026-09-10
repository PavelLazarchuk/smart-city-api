import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { type ClientSession, Connection } from 'mongoose';
import { PinoLogger } from 'nestjs-pino';

export type AfterCommitCallback = () => void | Promise<void>;

export interface TransactionContext {
    session: ClientSession;
    afterCommit(callback: AfterCommitCallback): void;
}

/**
 * Runs a unit of work inside a MongoDB transaction with the driver's retry semantics for transient
 * errors, and defers irreversible side effects (mail, SMS, storage) until after the commit.
 */
@Injectable()
export class TransactionRunner {
    constructor(
        @InjectConnection() private readonly connection: Connection,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(TransactionRunner.name);
    }

    async run<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T> {
        const session = await this.connection.startSession();
        let callbacks: AfterCommitCallback[] = [];
        let result: T | undefined;
        try {
            await session.withTransaction(async () => {
                callbacks = [];
                result = await work({
                    session,
                    afterCommit: (callback) => {
                        callbacks.push(callback);
                    },
                });
            });
        } finally {
            await session.endSession();
        }
        await this.flush(callbacks);

        return result as T;
    }

    private async flush(callbacks: AfterCommitCallback[]): Promise<void> {
        for (const callback of callbacks) {
            try {
                await callback();
            } catch (error) {
                this.logger.error({ err: error }, 'after-commit callback failed');
            }
        }
    }
}
