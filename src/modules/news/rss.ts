import { type NewsEntity } from './news.repository';

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

export interface RssChannel {
    title: string;
    link: string;
    description: string;
    itemLink(item: NewsEntity): string;
}

export interface RssEnclosure {
    type: string;
    length: number;
}

const EXTENSION_TYPES: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
};

const FALLBACK_TYPE = 'image/jpeg';

export function enclosureFor(url: string, images: Map<string, RssEnclosure>): RssEnclosure {
    const stored = images.get(url);

    if (stored) return stored;

    const path = url.split(/[?#]/)[0] ?? '';
    const dot = path.lastIndexOf('.');
    const extension = dot === -1 ? '' : path.slice(dot).toLowerCase();

    return { type: EXTENSION_TYPES[extension] ?? FALLBACK_TYPE, length: 0 };
}

export function renderRss(
    channel: RssChannel,
    items: NewsEntity[],
    images: Map<string, RssEnclosure> = new Map(),
): string {
    const lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0">',
        '<channel>',
        `<title>${escapeXml(channel.title)}</title>`,
        `<link>${escapeXml(channel.link)}</link>`,
        `<description>${escapeXml(channel.description)}</description>`,
        `<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
    ];

    for (const item of items) {
        const title = item.value.heading_value || item.label;
        const description = item.value.text_value ?? '';
        const link = channel.itemLink(item);
        const image = item.value.image_value;
        const enclosure = image ? enclosureFor(image, images) : undefined;
        lines.push(
            '<item>',
            `<title>${escapeXml(title)}</title>`,
            `<link>${escapeXml(link)}</link>`,
            `<guid isPermaLink="false">${escapeXml(item._id.toHexString())}</guid>`,
            `<pubDate>${item.date.toUTCString()}</pubDate>`,
            ...(item.rubric ? [`<category>${escapeXml(item.rubric)}</category>`] : []),
            `<description>${escapeXml(description)}</description>`,
            ...(image && enclosure
                ? [
                      `<enclosure url="${escapeXml(image)}" type="${escapeXml(enclosure.type)}" length="${enclosure.length}" />`,
                  ]
                : []),
            '</item>',
        );
    }

    lines.push('</channel>', '</rss>');

    return lines.join('\n');
}
