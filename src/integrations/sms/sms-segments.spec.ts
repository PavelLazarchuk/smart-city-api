import { fitSms, smsEncoding, splitSms } from './sms-segments';

describe('sms segments', () => {
    it('detects GSM and UCS-2 texts', () => {
        expect(smsEncoding('Hello {world} €')).toBe('gsm');
        expect(smsEncoding('Привіт')).toBe('ucs2');
        expect(smsEncoding('Hi 👋')).toBe('ucs2');
    });

    it('keeps a short message in one part', () => {
        expect(splitSms('a'.repeat(160))).toEqual({ encoding: 'gsm', parts: ['a'.repeat(160)] });
        expect(splitSms('я'.repeat(70)).parts).toHaveLength(1);
    });

    it('splits long UCS-2 text into 67-character parts', () => {
        const { encoding, parts } = splitSms('я'.repeat(200));

        expect(encoding).toBe('ucs2');
        expect(parts.map((part) => part.length)).toEqual([67, 67, 66]);
        expect(parts.join('')).toBe('я'.repeat(200));
    });

    it('counts GSM extension characters twice and never splits a surrogate pair', () => {
        expect(splitSms('{'.repeat(81)).parts.map((part) => part.length)).toEqual([76, 5]);

        const emoji = splitSms('👋'.repeat(40)).parts;

        expect(emoji.every((part) => !/[\uD800-\uDBFF]$/.test(part))).toBe(true);
        expect(emoji.join('')).toBe('👋'.repeat(40));
    });

    it('cuts a rendered text to the part limit with an ellipsis in the same alphabet', () => {
        const ucs = fitSms('я'.repeat(1000), 5);
        const gsm = fitSms('a'.repeat(1000), 2);

        expect(ucs).toHaveLength(335);
        expect(ucs.endsWith('…')).toBe(true);
        expect(gsm).toBe(`${'a'.repeat(303)}...`);
        expect(smsEncoding(gsm)).toBe('gsm');
        expect(fitSms('short')).toBe('short');
    });
});
