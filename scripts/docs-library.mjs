// Build the Bitbots documentation library: one portable, offline HTML file.
//
//   node scripts/docs-library.mjs build
//   node scripts/docs-library.mjs check
//   node scripts/docs-library.mjs serve --port 5205
//
// The library includes the hand-written pages in docs/library/content and every
// Markdown document in the checkout. Markdown is escaped at build time, raw HTML
// is shown as text, executable URL schemes are rejected, and local links are
// limited to files inside this checkout. No network access is used.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const library = path.join(root, 'docs', 'library');
const viewer = path.join(root, 'docs', 'DOCUMENTATION.html');
const { Marked } = await import('marked');
const icons = new Map();

const repositoryUrl = 'https://github.com/sico-vibes/bloblex/blob/main';

const definitions = [
  ['Learn', 'Quickstart', 'rocket', ['guides/five-minute-path', 'overview', 'glossary']],
  [
    'Learn',
    'Working with Bitbots',
    'layout-dashboard',
    [
      'guides/looks-and-appearance',
      'guides/bots',
      'guides/conversations-and-approvals',
      'guides/team-and-manager',
      'guides/companion-and-dictation',
      'guides/automations-memory-and-skills',
      'guides/remote-access',
      'guides/backup-updates-and-troubleshooting',
    ],
  ],
  [
    'Reference',
    'Architecture & internals',
    'blocks',
    [
      'reference/architecture',
      'reference/daemon-and-storage',
      'reference/ipc-and-events',
      'reference/runtimes-and-adapters',
      'reference/sessions-and-turns',
    ],
  ],
  [
    'Reference',
    'Permissions & appearance',
    'shield-check',
    [
      'reference/approvals-and-permissions',
      'reference/settings',
      'reference/theme-system',
      'reference/bot-art-system',
    ],
  ],
  [
    'Reference',
    'Remote, release & delivery',
    'terminal',
    [
      'reference/remote-gateway',
      'reference/release-and-updates',
      'reference/development-and-testing',
    ],
  ],
  ['Project library', 'Project documentation', 'book-open', []],
  ['Project library', 'Expansion handoff', 'clipboard-list', ['guides/expansion-handoff']],
  ['Project library', 'Design & product', 'pencil-ruler', []],
  ['Project library', 'Operations', 'settings-2', []],
  ['Project library', 'Legal', 'scale', []],
  ['Project library', 'Plans & briefs', 'clipboard-list', []],
  ['Project library', 'History records', 'history', []],
  ['Project library', 'Release notes', 'tag', []],
  ['Project library', 'Remote specifications', 'network', []],
  ['Project library', 'Evidence', 'file-check', []],
  ['Documentation', 'Audits & inventory', 'list-checks', []],
  ['Documentation', 'Library guide', 'library', []],
];

export const escapeHtml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export function jsonForHtml(value) {
  return JSON.stringify(value).replace(
    /[<\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function headingSlug(text) {
  return (
    text
      .replace(/<[^>]*>/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-') || 'section'
  );
}

export function insideRoot(candidate, base = root) {
  const relative = path.relative(base, path.resolve(candidate));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.css',
  '.js',
  '.mjs',
  '.svg',
  '.json',
  '.html',
]);

export function normalizeLineEndings(value) {
  return String(value).replaceAll('\r\n', '\n');
}

/** Hash text sources on LF; binary files stay byte-for-byte. */
export function hashSource(source, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const normalized = TEXT_EXTENSIONS.has(path.extname(source).toLowerCase())
    ? normalizeLineEndings(bytes.toString('utf8'))
    : bytes;
  return createHash('sha256').update(normalized).digest('hex');
}

export function routeFor(source) {
  if (source.startsWith('docs/library/content/')) {
    return source.slice('docs/library/content/'.length).replace(/\.md$/i, '');
  }
  if (source.startsWith('docs/library/audits/')) {
    return `audits/${source.slice('docs/library/audits/'.length).replace(/\.md$/i, '')}`;
  }
  if (source === 'docs/library/README.md') return 'library';
  if (source.startsWith('docs/')) return `project/${source.slice(5).replace(/\.md$/i, '')}`;
  return `repository/${source.replace(/\.md$/i, '')}`;
}

export function classify(source, route) {
  const curated = definitions.find((definition) => definition[3].includes(route));
  if (curated) {
    return {
      section: curated[1],
      status: route.startsWith('reference/') ? 'Reference' : 'Guide',
      priority: curated[3].indexOf(route),
    };
  }
  if (source.startsWith('docs/library/audits/')) {
    return { section: 'Audits & inventory', status: 'Lane record', priority: 0 };
  }
  if (source === 'docs/library/README.md') {
    return { section: 'Library guide', status: 'Library guide', priority: 0 };
  }
  if (source.startsWith('docs/audits/')) {
    return { section: 'Audits & inventory', status: 'Audit', priority: 0 };
  }
  if (source.startsWith('docs/design/')) {
    return { section: 'Design & product', status: 'Design rule', priority: 0 };
  }
  if (source.startsWith('docs/operations/')) {
    return { section: 'Operations', status: 'Operations', priority: 0 };
  }
  if (source.startsWith('docs/legal/')) {
    return { section: 'Legal', status: 'Legal notice', priority: 0 };
  }
  if (source.startsWith('docs/plans/')) {
    return { section: 'Plans & briefs', status: 'Plan', priority: 0 };
  }
  if (source.startsWith('docs/history/')) {
    return { section: 'History records', status: 'Historical record', priority: 0 };
  }
  if (source.startsWith('docs/releases/')) {
    return { section: 'Release notes', status: 'Release note', priority: 0 };
  }
  if (source.startsWith('docs/remote/')) {
    return { section: 'Remote specifications', status: 'Remote specification', priority: 0 };
  }
  if (source.startsWith('docs/evidence/')) {
    return { section: 'Evidence', status: 'Evidence', priority: 0 };
  }
  return { section: 'Project documentation', status: 'Project reference', priority: 0 };
}

async function walk(directory) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const found = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? walk(path.join(directory, entry.name))
        : path.join(directory, entry.name),
    ),
  );
  return found.flat();
}

async function discover() {
  const tracked = execFileSync(
    'git',
    ['ls-files', '--cached', '-z'],
    { cwd: root, encoding: 'utf8' },
  ).split('\0');
  const files = tracked.filter((source) => /\.md$/i.test(source));
  const newContent = await walk(path.join(library, 'content'));
  for (const source of newContent) {
    if (source.endsWith('.md')) files.push(path.relative(root, source).split(path.sep).join('/'));
  }
  const expansionDocs = [
    path.join(root, 'docs', 'operations', 'expansion-handoff-2026-10-21.md'),
    path.join(root, 'docs', 'plans', 'reference-expansion-plan.md'),
    ...(await walk(path.join(root, 'docs', 'history', 'expansion'))),
  ];
  for (const source of expansionDocs) {
    if (source.endsWith('.md') && existsSync(source)) files.push(path.relative(root, source).split(path.sep).join('/'));
  }
  return [...new Set(files)]
    .filter(
      (source) =>
        source &&
        !source.startsWith('docs/library/sources/') &&
        !source.startsWith('.dev/') &&
        !source.startsWith('.delegate/') &&
        !source.startsWith('.claude/') &&
        existsSync(path.join(root, source)),
    )
    .sort();
}

async function loadIcons() {
  const names = new Set([
    ...definitions.map((item) => item[2]),
    'search',
    'menu',
    'x',
    'chevron-right',
    'chevron-left',
    'chevron-down',
    'link',
    'copy',
    'download',
    'sun',
    'moon',
    'list',
    'arrow-up-right',
    'book-open',
    'file-check',
    'list-checks',
    'library',
    'history',
    'network',
    'tag',
    'terminal',
    'pencil-ruler',
    'settings-2',
    'scale',
    'shield-check',
    'blocks',
    'clipboard-list',
    'layout-dashboard',
    'rocket',
    'arrow-left',
    'maximize-2',
    'minimize-2',
  ]);
  const directory = path.join(root, 'node_modules', 'lucide-react', 'dist', 'esm', 'icons');
  for (const name of names) {
    const file = path.join(directory, `${name}.js`);
    if (!existsSync(file)) continue;
    const source = await readFile(file, 'utf8');
    const start = source.indexOf('[', source.indexOf('createLucideIcon'));
    const end = source.lastIndexOf(']');
    if (start === -1 || end === -1) continue;
    const nodes = Function(`return ${source.slice(start, end + 1)}`)();
    const markup = nodes
      .map(
        ([tag, attributes]) =>
          `<${tag} ${Object.entries(attributes)
            .filter(([key]) => key !== 'key')
            .map(([key, value]) => `${key}="${escapeHtml(value)}"`)
            .join(' ')} />`,
      )
      .join('');
    icons.set(
      name,
      `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${markup}</svg>`,
    );
  }
}

const icon = (name) => icons.get(name) || '';

function titleFrom(source, markdown) {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return (
    match?.[1] ||
    path.posix
      .basename(source)
      .replace(/\.md$/i, '')
      .replaceAll('-', ' ')
  )
    .replace(/[*`]/g, '')
    .trim();
}

export function plainText(markdown) {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*`>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function resolveLink(href, source, bySource) {
  let decoded;
  try {
    decoded = decodeURI(href.trim().replace(/^<|>$/g, ''));
  } catch {
    return { kind: 'blocked', reason: 'Malformed link' };
  }
  if (/^(https?:|mailto:)/i.test(decoded)) return { kind: 'external', href: decoded };
  if (/^[a-z][a-z\d+.-]*:/i.test(decoded) || decoded.startsWith('//') || decoded.startsWith('\\'))
    return { kind: 'blocked', reason: 'Unsupported link protocol' };
  const [relative, fragment] = decoded.split('#', 2);
  const target = relative
    ? path.resolve(root, path.dirname(source), relative.split('?')[0])
    : path.join(root, source);
  if (!insideRoot(target)) return { kind: 'blocked', reason: 'Link leaves the checkout' };
  const repositoryPath = path.relative(root, target).split(path.sep).join('/');
  if (repositoryPath === 'docs/DOCUMENTATION.html') {
    return { kind: 'document', href: '#guides/five-minute-path', target: 'guides/five-minute-path' };
  }
  const doc = bySource.get(repositoryPath) || bySource.get(`${repositoryPath}/README.md`);
  if (doc) {
    return {
      kind: 'document',
      href: `#${doc.id}${fragment ? `~${encodeURIComponent(fragment)}` : ''}`,
      target: doc.id,
      fragment,
    };
  }
  if (!existsSync(target)) {
    return {
      kind: 'missing',
      reason: `Source not present: ${repositoryPath}`,
      target: repositoryPath,
    };
  }
  return {
    kind: 'external',
    href: `${repositoryUrl}/${repositoryPath
      .split('/')
      .map(encodeURIComponent)
      .join('/')}${fragment ? `#${encodeURIComponent(fragment)}` : ''}`,
  };
}

function frontBlockHardBreaks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('>'));
  if (start === -1) return markdown;
  let end = start;
  while (end < lines.length && lines[end].startsWith('>')) end++;
  for (let index = start; index < end; index++) {
    if (!lines[index].endsWith('  ')) lines[index] += '  ';
  }
  return lines.join('\n');
}

export function renderMarkdown(document, bySource, warnings = []) {
  const headings = [];
  const used = new Map();
  const parser = new Marked({ gfm: true, breaks: false });  const renderer = {
    html({ text }) {
      return escapeHtml(text);
    },
    heading({ tokens, depth }) {
      const html = this.parser.parseInline(tokens);
      const text = html
        .replace(/<[^>]+>/g, '')
        .replaceAll('&amp;', '&')
        .replaceAll('&#39;', "'")
        .replaceAll('&quot;', '"')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>');
      const base = headingSlug(text);
      const count = used.get(base) || 0;
      used.set(base, count + 1);
      const id = count ? `${base}-${count}` : base;
      if (depth === 1 && headings.length === 0) {
        headings.push({ id, text, level: 1 });
        return '';
      }
      headings.push({ id, text, level: depth });
      return `<h${depth} id="${escapeHtml(id)}">${html}<a class="heading-anchor" href="#${document.id}~${encodeURIComponent(id)}" aria-label="Link to ${escapeHtml(text)}">${icon('link')}</a></h${depth}>\n`;
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!/^https?:/i.test(href) && /\.(png|jpe?g|webp|gif)$/i.test(href.split('?')[0])) {
        const image = path.resolve(root, path.dirname(document.source), href.split('?')[0]);
        if (insideRoot(image) && existsSync(image)) {
          return `<a href="__LOCAL_IMAGE_LINK__${encodeURIComponent(image)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${label}</a>`;
        }
      }
      const resolved = resolveLink(href, document.source, bySource);
      if (resolved.kind === 'blocked' || resolved.kind === 'missing') {
        if (resolved.kind === 'missing') {
          warnings.push({
            source: document.source,
            href,
            target: resolved.target,
            kind: 'missing',
          });
        } else {
          warnings.push({
            source: document.source,
            href,
            target: resolved.reason,
            kind: 'blocked',
          });
        }
        return `<span class="source-unavailable" title="${escapeHtml(resolved.reason)}">${label}</span>`;
      }
      return `<a href="${escapeHtml(resolved.href)}"${title ? ` title="${escapeHtml(title)}"` : ''}${resolved.kind === 'external' ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
    },
    image({ href, text }) {
      if (/^https?:/i.test(href)) {
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text || 'View external image')} ${icon('arrow-up-right')}</a>`;
      }
      const image = path.resolve(root, path.dirname(document.source), href.split('?')[0]);
      if (!insideRoot(image) || !/\.(png|jpg|jpeg|webp|gif|svg)$/i.test(image) || !existsSync(image)) {
        warnings.push({
          source: document.source,
          href,
          target: path.relative(root, image),
          kind: 'image',
        });
        return `<em>${escapeHtml(text || 'Image')} (see the original source)</em>`;
      }
      return `<figure class="figure"><img src="__LOCAL_IMAGE__${encodeURIComponent(image)}" alt="${escapeHtml(text || '')}" loading="lazy" /></figure>`;
    },
    code({ text, lang }) {
      return `<div class="code-block"><div class="code-toolbar"><span>${escapeHtml(lang?.split(/\s/)[0] || 'text')}</span><button type="button" data-copy-code aria-label="Copy code">${icon('copy')} Copy</button></div><pre><code>${escapeHtml(text)}</code></pre></div>\n`;
    },
  };
  parser.use({ renderer });
  let body = parser.parse(frontBlockHardBreaks(document.markdown));
  body = body
    .replace(
      /<table>/g,
      '<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table>',
    )
    .replace(/<\/table>/g, '</table></div>');
  return { body, headings: headings.filter((heading) => heading.level > 1 && heading.level < 4) };
}

function scopeSvg(svg) {
  return svg.replace(/<style>([\s\S]*?)<\/style>/g, (_, css) => {
    const scoped = css.replace(/(^|\n)(\s*)\.([a-z][a-z0-9-]*)\s*\{/g, '$1$2svg.diagram-svg .$3 {');
    return `<style>${scoped}</style>`;
  });
}

async function embedLocalImages(body) {
  const matches = [...body.matchAll(/__LOCAL_IMAGE__([^"<>]+)/g)];
  for (const match of matches) {
    const source = decodeURIComponent(match[1]);
    const extension = path.extname(source).slice(1).toLowerCase();
    if (extension === 'svg') {
      const svg = await readFile(source, 'utf8');
      if (/<script|on\w+\s*=|javascript:/i.test(svg)) {
        body = body.replace(
          `<img src="${match[0]}" alt="" loading="lazy" />`,
          '<em>Image refused: executable content</em>',
        );
        continue;
      }
      const cleaned = scopeSvg(svg)
        .replace(/<img src="[^"]*"[^>]*\/>/, '')
        .replace(/\sclass="diagram-svg"/, ' class="diagram-svg" role="img"');
      body = body.replace(
        /<figure class="figure"><img src="__LOCAL_IMAGE__[^"]+" alt="([^"]*)" loading="lazy" \/><\/figure>/,
        `<figure class="diagram"><button class="diagram-zoom" type="button" aria-expanded="false" aria-label="Expand diagram">${icon('maximize-2')} Expand</button>${cleaned}</figure>`,
      );
      continue;
    }
    const type = extension === 'jpg' ? 'jpeg' : extension;
    const bytes = await readFile(source);
    body = body.replace(match[0], `data:image/${type};base64,${bytes.toString('base64')}`);
  }
  const linkMatches = [...body.matchAll(/__LOCAL_IMAGE_LINK__([^"<>]+)/g)];
  for (const match of linkMatches) {
    const source = decodeURIComponent(match[1]);
    const extension = path.extname(source).slice(1).toLowerCase();
    const type = extension === 'jpg' ? 'jpeg' : extension;
    if (!insideRoot(source) || !['png', 'jpeg', 'webp', 'gif'].includes(type) || !existsSync(source)) continue;
    const bytes = await readFile(source);
    body = body.replace(match[0], `data:image/${type};base64,${bytes.toString('base64')}`);
  }
  return body;
}

function renderNavigation(sections, active) {
  let label = '';
  return sections
    .map((section) => {
      const newLabel =
        section.label !== label ? `<div class="nav-label">${escapeHtml(section.label)}</div>` : '';
      label = section.label;
      return `${newLabel}<details class="nav-section"${section.documents.some((doc) => doc.id === active) ? ' open' : ''}><summary><span class="section-icon">${icon(section.icon)}</span><span>${escapeHtml(section.name)}</span><span class="section-count">${section.documents.length}</span>${icon('chevron-right')}</summary><div class="nav-pages">${section.documents
        .map(
          (doc) =>
            `<a class="nav-link" data-doc-id="${escapeHtml(doc.id)}" href="#${escapeHtml(doc.id)}"${doc.id === active ? ' aria-current="page"' : ''}>${escapeHtml(doc.navTitle || doc.title)}</a>`,
        )
        .join('')}</div></details>`;
    })
    .join('');
}

function tocFor(doc) {
  return doc.headings
    .map(
      (heading) =>
        `<a class="toc-link level-${heading.level}" href="#${doc.id}~${encodeURIComponent(heading.id)}" data-heading="${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a>`,
    )
    .join('');
}

const notices = {
  'Historical record':
    '<strong>Historical record.</strong> This document records work at the time it was written. Use the current guides and reference pages for implemented behaviour.',
  Plan: '<strong>Plan or brief.</strong> This document records intent at the time it was written. It is not a description of what is implemented now.',
  'Release note':
    '<strong>Release note.</strong> Notes describe one published version. Later releases may have changed the behaviour.',
  Evidence:
    '<strong>Evidence record.</strong> This is a dated record of a probe or a run. It is not a promise about a later build.',
  'Remote specification':
    '<strong>Remote specification.</strong> This document describes the Remote design. Check its status line for what has been verified.',
  Audit:
    '<strong>Audit record.</strong> This document records a review at a point in time. Findings may since have been fixed.',
  'Lane record':
    '<strong>Lane record.</strong> This is a working record from a delivery lane, kept for continuity rather than as user guidance.',
};

export function renderArticle(doc) {
  const notice = notices[doc.status] || '';
  return `<div class="breadcrumb" aria-label="Breadcrumb"><span>${escapeHtml(doc.section)}</span><span class="separator">/</span><span class="current">${escapeHtml(doc.title)}</span></div><h1 class="article-title" id="page-title" tabindex="-1">${escapeHtml(doc.title)}</h1><div class="article-meta"><span class="chip">${escapeHtml(doc.section)}</span><div class="meta-actions"><button class="small-button" type="button" data-copy-page>${icon('link')}<span class="meta-action-label">Copy link</span></button><button class="small-button" type="button" data-download-markdown aria-label="Download this page as Markdown">${icon('download')}<span class="meta-action-label">Markdown</span></button><details class="mobile-toc"><summary class="small-button">${icon('list')} On this page ${doc.headings.length}${icon('chevron-down')}</summary><nav class="mobile-toc-links" aria-label="On this page">${tocFor(doc)}</nav></details></div></div>${notice ? `<aside class="document-notice">${notice}</aside>` : ''}<article class="article" id="article">${doc.body}</article><nav class="page-nav" id="page-nav" aria-label="Document navigation"></nav><p class="source-caption">Source: ${escapeHtml(doc.source)} · ${escapeHtml(doc.status)} · <a href="library/sources/${escapeHtml(doc.source)}" download>Original Markdown</a></p>`;
}

async function makeHtml(documents, sections, revision) {
  const first = documents.find((doc) => doc.id === 'guides/five-minute-path');
  if (!first) throw new Error('The five-minute path is missing');
  const tokens = await readFile(path.join(library, 'assets', 'tokens.css'), 'utf8');
  const styles = await readFile(path.join(library, 'assets', 'viewer.css'), 'utf8');
  const client = await readFile(path.join(library, 'assets', 'viewer.js'), 'utf8');
  const logo = (await readFile(path.join(library, 'assets', 'bitbots.png'))).toString('base64');
  const bundle = jsonForHtml({
    documents,
    sections: sections.map((section) => ({
      name: section.name,
      ids: section.documents.map((doc) => doc.id),
    })),
    revision,
    icons: Object.fromEntries(icons),
  });
  const shortcut = '#guides/five-minute-path';
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="description" content="Bitbots documentation: install, bots, looks, approvals, the daemon, Remote access and the project records."/>
<meta name="color-scheme" content="dark light"/>
<title>Bitbots documentation</title>
<link rel="icon" href="data:image/png;base64,${logo}"/>
<style>${tokens}
${styles}</style>
<script>try{document.documentElement.dataset.theme=localStorage.getItem('bitbots-docs-theme')==='light'?'light':'dark'}catch{}</script>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to content</a>
<header class="navbar"><div class="navbar-inner"><div class="navbar-left"><button class="mobile-menu" type="button" aria-label="Open navigation" aria-expanded="false" aria-controls="sidebar">${icon('menu')}</button><a class="navbar-link" href="#overview">Bitbots</a><a class="navbar-link" href="${shortcut}">Docs</a><a class="navbar-link" href="#project/README">Project documents</a></div><a class="wordmark" href="${shortcut}" aria-label="Bitbots Docs home"><img alt="" src="data:image/png;base64,${logo}" width="26" height="26"/>Bitbots <span>Docs</span></a><div class="navbar-right"><button class="search-button" type="button" data-open-search aria-label="Search documentation">${icon('search')}<span class="navbar-search-label">Search</span><kbd>Ctrl K</kbd></button></div></div></header>
<button class="menu-scrim" hidden aria-label="Close navigation"></button>
<div class="docs-layout">
<nav class="sidebar" id="sidebar" aria-label="Documentation"><button class="small-button mobile-close" type="button" data-close-menu>${icon('x')} Close</button><a class="nav-link" href="#project/README">${icon('chevron-left')} All documents</a>${renderNavigation(sections, first.id)}<p class="sidebar-note">${documents.length} documents. Local-first, fully searchable.<br/>Source snapshot ${escapeHtml(revision)}.</p></nav>
<main class="main-content" id="main-content">${renderArticle(first)}</main>
<aside class="toc-rail" aria-label="On this page"><div class="toc-inner"><h2 class="toc-title">On this page</h2><nav id="toc-links">${tocFor(first)}</nav></div></aside>
</div>
<footer class="footer"><div class="footer-inner"><div class="footer-wordmark">Bitbots<span>Docs</span></div><div class="footer-columns"><div><h2>Get started</h2><a href="${shortcut}">Five-minute path</a><a href="#overview">What Bitbots is</a><a href="#glossary">Glossary</a></div><div><h2>Use it</h2><a href="#guides/looks-and-appearance">Looks and appearance</a><a href="#guides/bots">Bots</a><a href="#guides/conversations-and-approvals">Conversations and approvals</a></div><div><h2>Understand it</h2><a href="#reference/architecture">Architecture</a><a href="#reference/ipc-and-events">IPC and events</a><a href="#reference/settings">Settings</a></div><div><h2>More</h2><a href="#reference/remote-gateway">Remote gateway</a><a href="#reference/release-and-updates">Release and updates</a><a href="#library">Library guide</a></div></div><div class="footer-bottom">Bitbots. Documentation built from this local checkout. No network access is used.</div></div></footer>
<button class="theme-toggle" type="button" aria-label="Switch to light theme">${icon('sun')}</button>
<dialog class="search-dialog" aria-labelledby="search-label"><div class="search-field">${icon('search')}<label class="sr-only" id="search-label" for="docs-search">Search Bitbots documentation</label><input id="docs-search" type="search" placeholder="Search documentation…" autocomplete="off" aria-controls="search-results"/><button type="button" data-close-search aria-label="Close search">Esc</button></div><div class="search-results" id="search-results" role="region" aria-label="Search results"></div><div class="search-hint"><span>↑ ↓ Navigate</span><span>Enter Open</span><span>Esc Close</span><span id="search-count" role="status"></span></div></dialog>
<div class="toast" role="status" aria-live="polite" hidden></div>
<noscript><p>Enable JavaScript for navigation and local search. Every source is also available as Markdown in the sources folder.</p></noscript>
<script id="docs-data" type="application/json">${bundle}</script>
<script>${client.replaceAll('</script', '<\\/script')}</script>
</body>
</html>`;
}

async function viewerSources() {
  const files = await walk(path.join(library, 'assets'));
  return ['scripts/docs-library.mjs', ...files.map((file) => path.relative(root, file).split(path.sep).join('/'))];
}

export async function build() {
  await loadIcons();
  const files = await discover();
  const documents = await Promise.all(
    files.map(async (source) => {
      const original = await readFile(path.join(root, source), 'utf8');
      const markdown = original.startsWith('\ufeff') ? original.slice(1) : original;
      const id = routeFor(source);
      return {
        id,
        source,
        title: titleFrom(source, markdown),
        markdown,
        original,
        text: plainText(markdown),
        sha256: hashSource(source, original),
        ...classify(source, id),
      };
    }),
  );
  const ids = new Set();
  for (const document of documents) {
    if (ids.has(document.id)) throw new Error(`Duplicate route: ${document.id}`);
    ids.add(document.id);
  }
  const bySource = new Map(documents.map((document) => [document.source, document]));
  const warnings = [];
  for (const document of documents) {
    const rendered = renderMarkdown(document, bySource, warnings);
    document.body = await embedLocalImages(rendered.body);
    document.headings = rendered.headings;
    const snapshot = path.join(library, 'sources', document.source);
    await mkdir(path.dirname(snapshot), { recursive: true });
    await writeFile(snapshot, document.original.replaceAll('\r\n', '\n'), 'utf8');
    delete document.original;
  }
  const sections = definitions
    .map(([label, name, sectionIcon]) => ({
      label,
      name,
      icon: sectionIcon,
      documents: documents
        .filter((document) => document.section === name)
        .sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title)),
    }))
    .filter((section) => section.documents.length);
  const ordered = sections.flatMap((section) => section.documents);
  const revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const html = await makeHtml(ordered, sections, revision);
  await writeFile(viewer, html, 'utf8');
  const manifest = {
    version: 1,
    viewer: 'docs/DOCUMENTATION.html',
    revision,
    documentCount: ordered.length,
    assets: await Promise.all(
      (await viewerSources()).map(async (source) => ({
        source,
        sha256: hashSource(source, await readFile(path.join(root, source))),
      })),
    ),
    documents: ordered.map(({ id, source, title, section, status, sha256, headings }) => ({
      id,
      source,
      title,
      section,
      status,
      sha256,
      headings,
    })),
    unresolvedLinks: warnings,
  };
  await writeFile(
    path.join(library, 'catalog.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  console.log(
    `Built ${ordered.length} documents into docs/DOCUMENTATION.html (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MiB). ${warnings.length} unresolved links recorded in catalog.json.`,
  );
  return manifest;
}

export async function check() {
  const manifest = JSON.parse(await readFile(path.join(library, 'catalog.json'), 'utf8'));
  const html = await readFile(viewer, 'utf8');
  const errors = [];
  if (existsSync(path.join(library, 'index.html'))) {
    errors.push('The old library viewer still exists; delete it before checking.');
  }
  if (manifest.viewer && manifest.viewer !== 'docs/DOCUMENTATION.html') {
    errors.push('The catalogue names the wrong viewer path; rebuild the library.');
  }
  for (const asset of manifest.assets || []) {
    const current = await readFile(path.join(root, asset.source));
    if (hashSource(asset.source, current) !== asset.sha256) {
      errors.push(`Stale viewer asset: ${asset.source}`);
    }
  }
  for (const doc of manifest.documents) {
    const current = await readFile(path.join(root, doc.source));
    if (hashSource(doc.source, current) !== doc.sha256) {
      errors.push(`Stale source: ${doc.source}`);
    }
    const snapshot = await readFile(path.join(library, 'sources', doc.source), 'utf8');
    if (normalizeLineEndings(snapshot) !== normalizeLineEndings(current.toString('utf8'))) {
      errors.push(`Stale snapshot: ${doc.source}`);
    }
  }
  const expected = await discover();
  if (
    expected.length !== manifest.documentCount ||
    expected.some((source) => !manifest.documents.some((doc) => doc.source === source))
  ) {
    errors.push('Document inventory has changed; rebuild the library.');
  }
  for (const warning of manifest.unresolvedLinks) {
    if (warning.kind === 'blocked') {
      errors.push(`Executable or outside-checkout link: ${warning.source}: ${warning.href}`);
    } else if (
      warning.source.startsWith('docs/library/content/') ||
      warning.kind === 'image'
    ) {
      errors.push(`Broken ${warning.kind === 'image' ? 'image' : 'maintained link'}: ${warning.source}: ${warning.href}`);
    }
  }
  if (!html.includes('id="docs-data"') || !html.includes('id="page-title"')) {
    errors.push('HTML has no embedded content or five-minute path.');
  }
  if (/<script[^>]+src=/.test(html) || /<link[^>]+rel="stylesheet"/.test(html)) {
    errors.push('HTML depends on external runtime assets.');
  }
  if (/<img[^>]+src="https?:/.test(html)) errors.push('HTML embeds a remote image.');
  if (/__LOCAL_IMAGE(?:_LINK)?__/.test(html)) errors.push('HTML contains an unresolved local image placeholder.');
  if (/\bferry\b/i.test(html)) errors.push('The output still contains the reference project name.');
  if (/\bferry\b/i.test(JSON.stringify(manifest))) errors.push('The catalogue still contains the reference project name.');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    `Documentation check passed: ${manifest.documentCount} source hashes and snapshots match; every catalogue document exists; links and images resolve; no executable link; no reference project name; the HTML is self-contained.`,
  );
}

export function createLibraryServer(directory = library) {
  return createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method || '')) {
        response.writeHead(405).end();
        return;
      }
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (relative.includes('\\') || relative.includes('\0')) {
        response.writeHead(400).end();
        return;
      }
      const isViewer =
        relative === '' || relative === 'DOCUMENTATION.html' || relative === 'index.html';
      const target = isViewer
        ? viewer
        : relative === 'library' || relative.startsWith('library/')
          ? path.resolve(root, 'docs', relative)
          : path.resolve(directory, relative);
      if (
        (!isViewer && !insideRoot(target, directory)) ||
        !/\.(html|json|md|css|js|png|svg|woff2)$/.test(target)
      ) {
        response.writeHead(404).end();
        return;
      }
      const data = await readFile(target);
      const types = {
        '.html': 'text/html',
        '.json': 'application/json',
        '.md': 'text/plain',
        '.css': 'text/css',
        '.js': 'text/javascript',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2',
      };
      response.writeHead(200, {
        'Content-Type': `${types[path.extname(target)] || 'text/plain'}; charset=utf-8`,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch {
      response.writeHead(404).end('Document not found');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || 'build';
  if (command === 'build') await build();
  else if (command === 'check') await check();
  else if (command === 'serve') {
    const index = process.argv.indexOf('--port');
    const port = index === -1 ? 5205 : Number(process.argv[index + 1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Choose a port between 1 and 65535.');
    }
    const server = createLibraryServer();
    server.on('error', (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () =>
      console.log(`Bitbots Docs: http://127.0.0.1:${port}`),
    );
  } else throw new Error(`Unknown command: ${command}. Use build, check or serve.`);
}
