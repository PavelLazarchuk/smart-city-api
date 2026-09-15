const TRANSLIT: Record<string, string> = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'yo',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'h',
    ц: 'ts',
    ч: 'ch',
    ш: 'sh',
    щ: 'sch',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya',
    ў: 'u',
    і: 'i',
    ґ: 'g',
    є: 'ye',
    ї: 'yi',
};

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 80;

export function slugify(input: string): string {
    const latin = [...input.toLowerCase()].map((char) => TRANSLIT[char] ?? char).join('');
    const slug = latin
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, SLUG_MAX_LENGTH)
        .replace(/-+$/g, '');

    return slug;
}

export async function uniqueSlug(
    base: string,
    taken: (candidate: string) => Promise<boolean>,
): Promise<string> {
    const root = base || 'item';

    if (!(await taken(root))) return root;

    for (let n = 2; n < 1000; n += 1) {
        const suffix = `-${n}`;
        const candidate = `${root.slice(0, SLUG_MAX_LENGTH - suffix.length)}${suffix}`;

        if (!(await taken(candidate))) return candidate;
    }

    throw new Error(`could not find a free slug for "${root}"`);
}
