export type TemplateValue = string | number | boolean | null | undefined;
export type TemplateData = Record<string, TemplateValue>;

type TemplateNode =
    | { kind: 'text'; value: string }
    | { kind: 'variable'; name: string }
    | { kind: 'section'; name: string; inverted: boolean; children: TemplateNode[] };

export class TemplateError extends Error {}

const TAG = /\{\{\s*([#^/]?)\s*([a-z_]+)\s*\}\}/g;
const STANDALONE = /^[ \t]*\{\{\s*[#^/]\s*[a-z_]+\s*\}\}[ \t]*$/;

function dropStandaloneLines(source: string): string {
    const lines = source.replace(/\r\n?/g, '\n').split('\n');

    return lines
        .map((line, index) => {
            if (STANDALONE.test(line)) return line.trim();

            return index === lines.length - 1 ? line : `${line}\n`;
        })
        .join('');
}

function literal(value: string): TemplateNode {
    if (value.includes('{{') || value.includes('}}'))
        throw new TemplateError(`Malformed tag near "${value.slice(0, 40)}"`);

    return { kind: 'text', value };
}

export function compileTemplate(source: string, variables: readonly string[]): TemplateNode[] {
    const root: TemplateNode[] = [];
    const stack: { name: string; children: TemplateNode[] }[] = [];
    const prepared = dropStandaloneLines(source);
    let cursor = 0;
    let children = root;

    for (const match of prepared.matchAll(TAG)) {
        const [tag] = match;
        const sigil = match[1] ?? '';
        const name = match[2] ?? '';

        if (match.index > cursor) children.push(literal(prepared.slice(cursor, match.index)));

        cursor = match.index + tag.length;

        if (!variables.includes(name)) throw new TemplateError(`Unknown variable "${name}"`);

        if (sigil === '/') {
            const open = stack.pop();

            if (!open || open.name !== name) throw new TemplateError(`Unexpected closing tag "{{/${name}}}"`);

            children = stack.at(-1)?.children ?? root;
            continue;
        }

        if (sigil === '') {
            children.push({ kind: 'variable', name });
            continue;
        }

        const section: TemplateNode = { kind: 'section', name, inverted: sigil === '^', children: [] };
        children.push(section);
        stack.push({ name, children: section.children });
        children = section.children;
    }

    if (cursor < prepared.length) children.push(literal(prepared.slice(cursor)));

    const unclosed = stack.pop();

    if (unclosed) throw new TemplateError(`Section "${unclosed.name}" is not closed`);

    return root;
}

function present(value: TemplateValue): boolean {
    return value !== undefined && value !== null && value !== '' && value !== false && value !== 0;
}

function renderNodes(nodes: TemplateNode[], data: TemplateData): string {
    return nodes
        .map((node) => {
            if (node.kind === 'text') return node.value;

            if (node.kind === 'variable') return present(data[node.name]) ? String(data[node.name]) : '';

            return present(data[node.name]) !== node.inverted ? renderNodes(node.children, data) : '';
        })
        .join('');
}

export function renderTemplate(source: string, variables: readonly string[], data: TemplateData): string {
    return renderNodes(compileTemplate(source, variables), data).trim();
}
