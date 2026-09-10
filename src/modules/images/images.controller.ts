import {
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
    Res,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { type Response } from 'express';

import { ApiPaginated } from '../../common/decorators/api-paginated.decorator';
import { OrganizationScope } from '../../common/decorators/organization-scope.decorator';
import { ROLES, Roles } from '../../common/decorators/roles.decorator';
import { Serialize, SerializePaginated } from '../../common/http/serialize.decorator';
import { type PaginatedResult } from '../../common/pagination/paginated-result';
import { ImageResponseDto, imageResponseSchema, ListImagesQueryDto } from './dto/image.schemas';
import { type ImageEntity } from './images.repository';
import { ImagesService, type UploadedFile as UploadedImage } from './images.service';

@ApiTags('images')
@ApiBearerAuth()
@Controller()
export class ImagesController {
    constructor(private readonly images: ImagesService) {}

    @Get('images')
    @Roles(ROLES.SUPER_ADMIN)
    @ApiPaginated(ImageResponseDto)
    @SerializePaginated(imageResponseSchema)
    list(@Query() query: ListImagesQueryDto): Promise<PaginatedResult<ImageEntity>> {
        return this.images.list(query);
    }

    @Post('organizations/:id/images')
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'path' })
    @UseInterceptors(FileInterceptor('file'))
    @ApiConsumes('multipart/form-data')
    @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
    @ApiCreatedResponse({ type: ImageResponseDto })
    @Serialize(imageResponseSchema)
    async upload(
        @Param('id') id: string,
        @UploadedFile() file: UploadedImage | undefined,
        @Res({ passthrough: true }) res: Response,
    ): Promise<ImageEntity> {
        const image = await this.images.upload(id, file);
        res.setHeader('Location', `/images/${image._id.toHexString()}`);

        return image;
    }

    @Delete('images/:id')
    @Roles(ROLES.COMMON_ADMIN, ROLES.SUPER_ADMIN)
    @OrganizationScope({ from: 'entity', entity: 'image' })
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Param('id') id: string): Promise<void> {
        await this.images.delete(id);
    }
}
