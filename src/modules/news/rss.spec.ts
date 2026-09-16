import { Types } from 'mongoose';

import { type NewsEntity } from './news.repository';
import { enclosureFor, renderRss, type RssEnclosure } from './rss';

const item = (imageValue?: string): NewsEntity => ({
    _id: new Types.ObjectId(),
    organization_id: new Types.ObjectId(),
    position: 0,
    label: 'Item',
    enabled: true,
    publish_at: null,
    date: new Date('2026-03-01T10:00:00.000Z'),
    is_main: false,
    is_offer: false,
    value: imageValue ? { image_value: imageValue } : {},
    created_at: new Date(),
    updated_at: new Date(),
});

const channel = {
    title: 'News',
    link: 'https://city.example.com/news',
    description: 'News',
    itemLink: () => 'https://city.example.com/news/1',
};

describe('enclosureFor', () => {
    const stored = new Map<string, RssEnclosure>([
        ['https://cdn.example.com/a/b.bin', { type: 'image/webp', length: 4096 }],
    ]);

    it('prefers the stored row over the extension', () => {
        expect(enclosureFor('https://cdn.example.com/a/b.bin', stored)).toEqual({
            type: 'image/webp',
            length: 4096,
        });
    });

    it('falls back to the extension, ignoring the query string and the case', () => {
        expect(enclosureFor('https://cdn.example.com/a.PNG?v=2', stored).type).toBe('image/png');
        expect(enclosureFor('https://cdn.example.com/a.gif#top', stored).type).toBe('image/gif');
        expect(enclosureFor('https://cdn.example.com/a.jpeg', stored).type).toBe('image/jpeg');
    });

    it('guesses jpeg for a URL with neither', () => {
        expect(enclosureFor('https://cdn.example.com/photo', stored)).toEqual({
            type: 'image/jpeg',
            length: 0,
        });
    });
});

describe('renderRss', () => {
    it('renders the enclosure with the stored type and size', () => {
        const images = new Map<string, RssEnclosure>([
            ['https://cdn.example.com/a.bin', { type: 'image/png', length: 1234 }],
        ]);
        const xml = renderRss(channel, [item('https://cdn.example.com/a.bin')], images);
        expect(xml).toContain(
            '<enclosure url="https://cdn.example.com/a.bin" type="image/png" length="1234" />',
        );
    });

    it('leaves out the enclosure when the item has no image', () => {
        expect(renderRss(channel, [item()])).not.toContain('<enclosure');
    });
});
