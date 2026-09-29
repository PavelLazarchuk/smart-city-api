import sanitizeHtml from 'sanitize-html';

const RICH_TEXT: sanitizeHtml.IOptions = {
    allowedTags: [
        'p',
        'br',
        'strong',
        'b',
        'em',
        'i',
        'u',
        's',
        'ul',
        'ol',
        'li',
        'h2',
        'h3',
        'h4',
        'blockquote',
        'a',
        'img',
    ],
    allowedAttributes: { a: ['href', 'title', 'rel'], img: ['src', 'alt'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: false,
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true) },
};

export function sanitizeRichText(value: string): string {
    return sanitizeHtml(value, RICH_TEXT);
}
