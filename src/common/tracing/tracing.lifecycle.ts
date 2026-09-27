import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

import { stopTracing } from './tracing';

@Injectable()
export class TracingLifecycle implements OnApplicationShutdown {
    onApplicationShutdown(): Promise<void> {
        return stopTracing();
    }
}
