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

export function renderRss(channel: RssChannel, items: NewsEntity[]): string {
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
        lines.push(
            '<item>',
            `<title>${escapeXml(title)}</title>`,
            `<link>${escapeXml(link)}</link>`,
            `<guid isPermaLink="false">${escapeXml(item._id.toHexString())}</guid>`,
            `<pubDate>${item.date.toUTCString()}</pubDate>`,
            ...(item.rubric ? [`<category>${escapeXml(item.rubric)}</category>`] : []),
            `<description>${escapeXml(description)}</description>`,
            ...(item.value.image_value
                ? [`<enclosure url="${escapeXml(item.value.image_value)}" type="image/jpeg" length="0" />`]
                : []),
            '</item>',
        );
    }

    lines.push('</channel>', '</rss>');

    return lines.join('\n');
}
