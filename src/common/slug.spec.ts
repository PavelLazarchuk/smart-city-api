import { slugify, uniqueSlug } from './slug';

describe('slug', () => {
    it('transliterates cyrillic, drops the rest and collapses dashes', () => {
        expect(slugify('Приём терапевта № 1')).toBe('priyom-terapevta-no-1');
        expect(slugify('  Hello,   World!  ')).toBe('hello-world');
        expect(slugify('Café déjà vu')).toBe('cafe-deja-vu');
        expect(slugify('!!!')).toBe('');
        expect(slugify('x'.repeat(200))).toHaveLength(80);
    });

    it('suffixes until the slug is free', async () => {
        const taken = new Set(['clinic', 'clinic-2']);
        expect(await uniqueSlug('clinic', (candidate) => Promise.resolve(taken.has(candidate)))).toBe(
            'clinic-3',
        );
        expect(await uniqueSlug('', () => Promise.resolve(false))).toBe('item');
    });
});
