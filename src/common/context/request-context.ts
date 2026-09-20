import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextData {
    request_id: string;
    user_id?: string;
}

export class RequestContext {
    private static readonly storage = new AsyncLocalStorage<RequestContextData>();

    static run<T>(data: RequestContextData, fn: () => T): T {
        return RequestContext.storage.run(data, fn);
    }

    static get(): RequestContextData | undefined {
        return RequestContext.storage.getStore();
    }

    static requestId(): string | undefined {
        return RequestContext.storage.getStore()?.request_id;
    }
}
