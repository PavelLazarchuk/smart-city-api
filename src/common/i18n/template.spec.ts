import { compileTemplate, renderTemplate, TemplateError } from './template';

const VARIABLES = ['service', 'date', 'time', 'reason', 'missed'];

describe('template', () => {
    it('substitutes variables and drops missing ones', () => {
        expect(renderTemplate('{{service}} at {{ time }}', VARIABLES, { service: 'Clinic' })).toBe(
            'Clinic at',
        );
        expect(renderTemplate('{{missed}}', VARIABLES, { missed: 3 })).toBe('3');
    });

    it('renders a section when the value is present and an inverted one when it is not', () => {
        const source =
            'on {{#date}}{{date}}{{/date}}{{^date}}the agreed date{{/date}}{{#time}} at {{time}}{{/time}}.';

        expect(renderTemplate(source, VARIABLES, { date: '2026-10-05', time: '10:00' })).toBe(
            'on 2026-10-05 at 10:00.',
        );
        expect(renderTemplate(source, VARIABLES, { date: '', missed: 0 })).toBe('on the agreed date.');
        expect(renderTemplate('{{#missed}}x{{/missed}}', VARIABLES, { missed: 0 })).toBe('');
    });

    it('nests sections', () => {
        const source = '{{#date}}{{date}}{{#time}}, {{time}}{{/time}}{{/date}}';

        expect(renderTemplate(source, VARIABLES, { time: '10:00' })).toBe('');
        expect(renderTemplate(source, VARIABLES, { date: 'd', time: 't' })).toBe('d, t');
    });

    it('removes a line that holds only a section tag together with its line break', () => {
        const source = ['Cancelled.', '{{#reason}}', 'Reason: {{reason}}', '{{/reason}}', 'Bye.'].join(
            '\r\n',
        );

        expect(renderTemplate(source, VARIABLES, { reason: 'Ill' })).toBe('Cancelled.\nReason: Ill\nBye.');
        expect(renderTemplate(source, VARIABLES, {})).toBe('Cancelled.\nBye.');
    });

    it('refuses unknown variables and broken tags', () => {
        const refused = (source: string): string => {
            try {
                compileTemplate(source, VARIABLES);
            } catch (error) {
                expect(error).toBeInstanceOf(TemplateError);

                return (error as Error).message;
            }

            throw new Error(`accepted ${source}`);
        };

        expect(refused('{{password}}')).toContain('password');
        expect(refused('{{#date}}x')).toContain('not closed');
        expect(refused('{{#date}}x{{/time}}')).toContain('Unexpected closing tag');
        expect(refused('x{{/date}}')).toContain('Unexpected closing tag');
        expect(refused('{{Service}}')).toContain('Malformed');
        expect(refused('{{service}')).toContain('Malformed');
        expect(refused('{{ }}')).toContain('Malformed');
    });
});
