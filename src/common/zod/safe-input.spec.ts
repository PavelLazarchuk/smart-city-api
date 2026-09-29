import { createCategorySchema } from '../../modules/categories/dto/category.schemas';
import { createNewsSchema } from '../../modules/news/dto/news.schemas';
import { safeLinkSchema, urlSchema } from './primitives';

describe('safeLinkSchema', () => {
    it.each(['https://a.b/x.png', 'http://a.b', '/uploads/x.png'])('accepts %s', (value) => {
        expect(safeLinkSchema.safeParse(value).success).toBe(true);
    });

    it.each(['javascript:alert(1)', 'data:text/html,x', '//evil.com/x', 'not a url'])(
        'rejects %s',
        (value) => {
            expect(safeLinkSchema.safeParse(value).success).toBe(false);
        },
    );
});

describe('urlSchema', () => {
    it('rejects non-http protocols', () => {
        expect(urlSchema.safeParse('javascript:alert(1)').success).toBe(false);
        expect(urlSchema.safeParse('https://a.b').success).toBe(true);
    });
});

describe('sanitized input schemas', () => {
    const organizationId = '66f8a0aa1b2c3d4e5f6a7b8c';

    it('strips scripts from news content', () => {
        const parsed = createNewsSchema.parse({
            organization_id: organizationId,
            label: 'n',
            value: { text_value: '<p>ok</p><script>x()</script>', heading_value: '<b onclick="x()">h</b>' },
        });

        expect(parsed.value).toEqual({ text_value: '<p>ok</p>', heading_value: '<b>h</b>' });
    });

    it('rejects a javascript: link in news content', () => {
        const result = createNewsSchema.safeParse({
            organization_id: organizationId,
            label: 'n',
            value: { link_value: 'javascript:alert(1)' },
        });

        expect(result.success).toBe(false);
    });

    it('strips scripts from a category description', () => {
        const parsed = createCategorySchema.parse({
            organization_id: organizationId,
            label: 'c',
            description: '<i>a</i><script>x()</script>',
        });

        expect(parsed.description).toBe('<i>a</i>');
    });
});
