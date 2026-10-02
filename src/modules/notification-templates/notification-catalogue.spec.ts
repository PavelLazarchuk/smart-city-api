import { texts } from '../../common/i18n/messages';
import { compileTemplate } from '../../common/i18n/template';
import { NOTIFICATION_KEYS, NOTIFICATIONS } from './notification-catalogue';

describe('notification catalogue', () => {
    it.each(NOTIFICATION_KEYS)('%s has a default that uses only its own variables', (key) => {
        const { channel, variables } = NOTIFICATIONS[key];
        const template = texts.notifications[key];

        expect(() => compileTemplate(template.body, variables)).not.toThrow();
        expect(template.subject === null).toBe(channel === 'sms');

        if (template.subject) expect(() => compileTemplate(template.subject, variables)).not.toThrow();
    });

    it('has a sample value for every variable', () => {
        const sample = Object.keys(texts.notificationSample);

        for (const key of NOTIFICATION_KEYS)
            expect(NOTIFICATIONS[key].variables.filter((name) => !sample.includes(name))).toEqual([]);
    });
});
