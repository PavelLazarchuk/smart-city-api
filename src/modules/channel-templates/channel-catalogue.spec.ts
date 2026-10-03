import { texts } from '../../common/i18n/messages';
import { compileTemplate } from '../../common/i18n/template';
import { CHANNEL_TEMPLATE_KEYS, CHANNEL_TEMPLATES } from './channel-catalogue';

describe('channel template catalogue', () => {
    it.each(CHANNEL_TEMPLATE_KEYS)('%s has a default that uses only its own variables', (key) => {
        const { channel, variables } = CHANNEL_TEMPLATES[key];
        const template = texts.channels[key];

        expect(() => compileTemplate(template.body, variables)).not.toThrow();
        expect(template.subject === null).toBe(channel === 'sms');

        if (template.subject) expect(() => compileTemplate(template.subject, variables)).not.toThrow();
    });

    it('has a sample value for every variable', () => {
        const sample = Object.keys(texts.channelSample);

        for (const key of CHANNEL_TEMPLATE_KEYS)
            expect(CHANNEL_TEMPLATES[key].variables.filter((name) => !sample.includes(name))).toEqual([]);
    });
});
