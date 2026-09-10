import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AUTH_USER_RESOLVER } from '../../common/guards/auth-user.resolver';
import { AuthStoreModule } from '../auth/store/auth-store.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { User, UserSchema } from './schemas/user.schema';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

@Module({
    imports: [
        MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
        AuthStoreModule,
        OrganizationsModule,
    ],
    controllers: [UsersController],
    providers: [
        UsersRepository,
        UsersService,
        {
            provide: AUTH_USER_RESOLVER,
            useFactory: (users: UsersService) => ({
                resolve: (id: string, sid: string) => users.resolveAuthUser(id, sid),
            }),
            inject: [UsersService],
        },
    ],
    exports: [UsersService, AUTH_USER_RESOLVER],
})
export class UsersModule {}
