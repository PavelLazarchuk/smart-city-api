import { sanitizeRichText } from './html';

describe('sanitizeRichText', () => {
    it('keeps allowed formatting', () => {
        expect(sanitizeRichText('<p>Hi <strong>there</strong></p>')).toBe('<p>Hi <strong>there</strong></p>');
    });

    it('drops scripts, event handlers and inline styles', () => {
        expect(sanitizeRichText('<p onclick="x()" style="color:red">a</p><script>alert(1)</script>')).toBe(
            '<p>a</p>',
        );
    });

    it('rejects javascript: links and images', () => {
        expect(sanitizeRichText('<a href="javascript:alert(1)">x</a>')).toBe(
            '<a rel="noopener noreferrer">x</a>',
        );
        expect(sanitizeRichText('<img src="javascript:alert(1)">')).toBe('<img />');
    });

    it('adds rel to links', () => {
        expect(sanitizeRichText('<a href="https://a.b">x</a>')).toBe(
            '<a href="https://a.b" rel="noopener noreferrer">x</a>',
        );
    });
});
