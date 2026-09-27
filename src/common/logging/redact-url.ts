const SECRET_QUERY_KEYS = new Set(['token']);
const REDACTED = '[redacted]';

function decodedKey(key: string): string {
    try {
        return decodeURIComponent(key.replace(/\+/g, ' ')).toLowerCase();
    } catch {
        return key.toLowerCase();
    }
}

function redactQuery(query: string): string {
    return query
        .split('&')
        .map((pair) => {
            const separator = pair.indexOf('=');
            const key = separator === -1 ? pair : pair.slice(0, separator);

            return separator !== -1 && SECRET_QUERY_KEYS.has(decodedKey(key)) ? `${key}=${REDACTED}` : pair;
        })
        .join('&');
}

export function redactUrl(url: string | undefined): string {
    const value = url ?? '';
    const hash = value.indexOf('#');
    const main = hash === -1 ? value : value.slice(0, hash);
    const fragment = hash === -1 ? '' : value.slice(hash);
    const mark = main.indexOf('?');

    if (mark === -1) return main.includes('/') ? value : redactQuery(main) + fragment;

    return `${main.slice(0, mark + 1)}${redactQuery(main.slice(mark + 1))}${fragment}`;
}
