import { createCategorySchema } from '../../modules/categories/dto/category.schemas';
import { createInfoSectionSchema } from '../../modules/infosections/dto/infosection.schemas';
import { createNewsSchema } from '../../modules/news/dto/news.schemas';
import { linkUrlSchema, richTextSchema, safeLinkSchema, urlSchema } from './primitives';

describe('safeLinkSchema', () => {
    it.each(['https://a.b/x.png', 'http://a.b', '/uploads/x.png', ''])('accepts %j', (value) => {
        expect(safeLinkSchema.safeParse(value).success).toBe(true);
    });

    it.each([
        'javascript:alert(1)',
        'data:text/html,x',
        '//evil.com/x',
        '/\\evil.com',
        '/\t/evil.com',
        'https://',
        'not a url',
    ])('rejects %j', (value) => {
        expect(safeLinkSchema.safeParse(value).success).toBe(false);
    });
});

describe('urlSchema', () => {
    it('rejects non-http protocols', () => {
        expect(urlSchema.safeParse('javascript:alert(1)').success).toBe(false);
        expect(urlSchema.safeParse('https://a.b').success).toBe(true);
    });
});

describe('linkUrlSchema', () => {
    it.each([
        'https://a.b',
        'mailto:info@city.gov',
        'tel:+380441234567',
        'viber://chat?number=1',
        'tg://resolve?domain=x',
    ])('accepts %s', (value) => {
        expect(linkUrlSchema.safeParse(value).success).toBe(true);
    });

    it('rejects javascript: links', () => {
        expect(linkUrlSchema.safeParse('javascript:alert(1)').success).toBe(false);
    });
});

describe('richTextSchema', () => {
    it('applies the length limit to the sanitized value', () => {
        expect(richTextSchema(10).safeParse('&&&&&').success).toBe(false);
        expect(richTextSchema(10).safeParse('&&').success).toBe(true);
    });
});

describe('sanitized input schemas', () => {
    const organizationId = '66f8a0aa1b2c3d4e5f6a7b8c';

    it('strips scripts from news content', () => {
        const parsed = createNewsSchema.parse({
            organization_id: organizationId,
            label: 'n',
            value: { text_value: '<p>ok</p><script>x()</script>', heading_value: 'Tom & Jerry' },
        });

        expect(parsed.value).toEqual({ text_value: '<p>ok</p>', heading_value: 'Tom & Jerry' });
    });

    it('rejects a javascript: link in news content', () => {
        const result = createNewsSchema.safeParse({
            organization_id: organizationId,
            label: 'n',
            value: { link_value: 'javascript:alert(1)' },
        });

        expect(result.success).toBe(false);
    });

    it('allows clearing news links with an empty string', () => {
        const parsed = createNewsSchema.parse({
            organization_id: organizationId,
            label: 'n',
            value: { image_value: '', link_value: '' },
        });

        expect(parsed.value).toEqual({ image_value: '', link_value: '' });
    });

    it('strips scripts from a category description', () => {
        const parsed = createCategorySchema.parse({
            organization_id: organizationId,
            label: 'c',
            description: '<i>a</i><script>x()</script>',
        });

        expect(parsed.description).toBe('<i>a</i>');
    });

    it('accepts a mailto: link section', () => {
        const result = createInfoSectionSchema.safeParse({
            organization_id: organizationId,
            label: 'l',
            control: 'link',
            value: { url: 'mailto:info@city.gov' },
        });

        expect(result.success).toBe(true);
    });
});
