import { Global, Module } from '@nestjs/common';

import { CascadeRegistry } from './cascade/cascade.registry';
import { ScopeResolverRegistry } from './guards/scope-resolver.registry';
import { PaginationService } from './pagination/pagination.service';

@Global()
@Module({
    providers: [ScopeResolverRegistry, CascadeRegistry, PaginationService],
    exports: [ScopeResolverRegistry, CascadeRegistry, PaginationService],
})
export class CommonModule {}
