import { Global, Module } from '@nestjs/common';

import { CascadeRegistry } from './cascade/cascade.registry';
import { ScopeResolverRegistry } from './guards/scope-resolver.registry';
import { PaginationService } from './pagination/pagination.service';
import { TracingLifecycle } from './tracing/tracing.lifecycle';

@Global()
@Module({
    providers: [ScopeResolverRegistry, CascadeRegistry, PaginationService, TracingLifecycle],
    exports: [ScopeResolverRegistry, CascadeRegistry, PaginationService],
})
export class CommonModule {}
