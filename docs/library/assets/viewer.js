(() => {
  'use strict';

  const bundle = JSON.parse(document.getElementById('docs-data').textContent);
  const documents = bundle.documents;
  const byId = new Map(documents.map((doc) => [doc.id, doc]));
  const main = document.getElementById('main-content');
  main.tabIndex = -1;
  const sidebar = document.getElementById('sidebar');
  const toc = document.getElementById('toc-links');
  const searchDialog = document.querySelector('.search-dialog');
  const searchInput = document.getElementById('docs-search');
  const results = document.getElementById('search-results');
  const toast = document.querySelector('.toast');
  let currentId = '';
  let toastTimeout;
  let observer;
  let searchIndex = -1;
  let restoreSearchFocus;
  let searchTimer;

  const escape = (value) =>
    String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  const icon = (name) => bundle.icons[name] || '';
  const hashFor = (id, heading) => `#${id}${heading ? `~${encodeURIComponent(heading)}` : ''}`;
  const tocFor = (doc) =>
    doc.headings
      .map(
        (heading) =>
          `<a class="toc-link level-${heading.level}" href="${hashFor(doc.id, heading.id)}" data-heading="${escape(heading.id)}">${escape(heading.text)}</a>`,
      )
      .join('');

  function notify(message) {
    clearTimeout(toastTimeout);
    toast.textContent = message;
    toast.hidden = false;
    toastTimeout = setTimeout(() => {
      toast.hidden = true;
    }, 2600);
  }

  function closeMenu() {
    document.body.classList.remove('menu-open');
    document.querySelector('.menu-scrim').hidden = true;
    document.querySelector('.mobile-menu').setAttribute('aria-expanded', 'false');
    sidebar.removeAttribute('role');
    sidebar.removeAttribute('aria-modal');
  }

  function openMenu() {
    document.body.classList.add('menu-open');
    document.querySelector('.menu-scrim').hidden = false;
    document.querySelector('.mobile-menu').setAttribute('aria-expanded', 'true');
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
    sidebar.querySelector('button').focus();
  }

  function render(doc) {
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
    const notice = notices[doc.status];
    main.innerHTML = `<div class="breadcrumb" aria-label="Breadcrumb"><span>${escape(doc.section)}</span><span class="separator">/</span><span class="current">${escape(doc.title)}</span></div><h1 class="article-title" id="page-title" tabindex="-1">${escape(doc.title)}</h1><div class="article-meta"><span class="chip">${escape(doc.section)}</span><div class="meta-actions"><button class="small-button" type="button" data-copy-page>${icon('link')}<span class="meta-action-label">Copy link</span></button><button class="small-button" type="button" data-download-markdown aria-label="Download this page as Markdown">${icon('download')}<span class="meta-action-label">Markdown</span></button><details class="mobile-toc"><summary class="small-button">${icon('list')} On this page ${doc.headings.length}${icon('chevron-down')}</summary><nav class="mobile-toc-links" aria-label="On this page">${tocFor(doc)}</nav></details></div></div>${notice ? `<aside class="document-notice">${notice}</aside>` : ''}<article class="article" id="article">${doc.body}</article><nav class="page-nav" id="page-nav" aria-label="Document navigation"></nav><p class="source-caption">Source: ${escape(doc.source)} · ${escape(doc.status)} · <a href="library/sources/${escape(doc.source)}" download>Original Markdown</a></p>`;
    toc.innerHTML = tocFor(doc);
    document.querySelector('.toc-rail').hidden = doc.headings.length === 0;
    const index = documents.indexOf(doc);
    const previous = documents[index - 1];
    const next = documents[index + 1];
    document.getElementById('page-nav').innerHTML = `${
      previous
        ? `<a href="${hashFor(previous.id)}"><small>Previous</small><span>${escape(previous.title)}</span></a>`
        : ''
    }${
      next
        ? `<a class="next" href="${hashFor(next.id)}"><small>Next</small><span>${escape(next.title)}</span></a>`
        : ''
    }`;
    for (const link of sidebar.querySelectorAll('[data-doc-id]')) {
      if (link.dataset.docId === doc.id) {
        link.setAttribute('aria-current', 'page');
        link.closest('details').open = true;
      } else link.removeAttribute('aria-current');
    }
    document.title = `${doc.title} | Bitbots Docs`;
    observeHeadings();
  }

  function observeHeadings() {
    observer?.disconnect();
    if (!('IntersectionObserver' in window)) return;
    observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (!visible) return;
        for (const link of document.querySelectorAll('.toc-link')) {
          if (link.dataset.heading === visible.target.id)
            link.setAttribute('aria-current', 'location');
          else link.removeAttribute('aria-current');
        }
      },
      { rootMargin: '-132px 0px -60% 0px', threshold: 0 },
    );
    for (const heading of main.querySelectorAll('h2[id], h3[id]')) observer.observe(heading);
  }

  function navigate() {
    const [id = '', encodedHeading] = location.hash.slice(1).split('~', 2);
    if (id === 'main-content') {
      main.focus();
      return;
    }
    const doc = byId.get(id || 'guides/five-minute-path');
    if (!doc) {
      main.innerHTML = `<h1 class="article-title" id="page-title">Document not found</h1><p>This document is not in this library. Search for its title or <a href="#guides/five-minute-path">return to the five-minute path</a>.</p>`;
      toc.innerHTML = '';
      currentId = '';
      document.title = 'Document not found | Bitbots Docs';
      closeMenu();
      return;
    }
    const hadPage = Boolean(currentId);
    const changed = currentId !== doc.id;
    if (changed) {
      render(doc);
      currentId = doc.id;
    }
    closeMenu();
    document.querySelector('.mobile-toc')?.removeAttribute('open');
    let heading;
    try {
      heading = encodedHeading ? decodeURIComponent(encodedHeading) : '';
    } catch {
      heading = '';
    }
    requestAnimationFrame(() => {
      const target = heading ? document.getElementById(heading) : null;
      if (target) target.scrollIntoView({ block: 'start' });
      else if (changed) {
        window.scrollTo({ top: 0 });
        if (hadPage) document.getElementById('page-title').focus({ preventScroll: true });
      }
    });
  }

  async function copy(text, success) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      notify(success);
    } catch {
      notify(
        'Clipboard access is unavailable. Select and copy the text, or download the Markdown.',
      );
    }
  }

  function search(query) {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = documents
      .map((doc) => {
        const title = doc.title.toLocaleLowerCase();
        const text = doc.text.toLocaleLowerCase();
        const score = terms.reduce(
          (total, term) => total + (title.includes(term) ? 12 : text.includes(term) ? 1 : -1000),
          0,
        );
        return { doc, score };
      })
      .filter(({ score }) => score >= 0)
      .sort((a, b) => b.score - a.score || documents.indexOf(a.doc) - documents.indexOf(b.doc));
    const shown = matches.slice(0, 30);
    searchIndex = -1;
    results.innerHTML = shown.length
      ? shown
          .map(({ doc }) => {
            const at = terms.length
              ? Math.max(0, doc.text.toLocaleLowerCase().indexOf(terms[0]) - 45)
              : 0;
            const excerpt = doc.text.slice(at, at + 150);
            return `<a class="search-result" href="${hashFor(doc.id)}"><div class="search-result-title">${escape(doc.title)}</div><div class="search-result-meta">${escape(doc.section)} · ${escape(doc.status)}</div><div class="search-result-meta">${at ? '…' : ''}${escape(excerpt)}${doc.text.length > at + 150 ? '…' : ''}</div></a>`;
          })
          .join('')
      : '<p class="search-empty">No documents match. Try a bot, a look, a settings key, a command or an error message.</p>';
    document.getElementById('search-count').textContent = `${matches.length} ${
      matches.length === 1 ? 'document' : 'documents'
    }${matches.length > 30 ? ' · showing 30' : ''}`;
  }

  function openSearch() {
    restoreSearchFocus = document.activeElement;
    searchDialog.showModal();
    searchInput.value = '';
    search('');
    searchInput.focus();
  }

  function closeSearch() {
    searchDialog.close();
    restoreSearchFocus?.focus();
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('a, button');
    if (!target) return;
    if (target.matches('[data-open-search]')) openSearch();
    if (target.matches('[data-close-search]')) closeSearch();
    if (target.matches('.mobile-menu'))
      document.body.classList.contains('menu-open') ? closeMenu() : openMenu();
    if (target.matches('[data-close-menu], .menu-scrim')) {
      closeMenu();
      document.querySelector('.mobile-menu').focus();
    }
    if (target.matches('.search-result')) closeSearch();
    if (target.matches('.nav-link') && document.body.classList.contains('menu-open')) closeMenu();
    if (target.matches('[data-copy-page]')) void copy(location.href, 'Page link copied');
    if (target.matches('[data-copy-code]'))
      void copy(target.closest('.code-block').querySelector('code').textContent, 'Code copied');
    if (target.matches('[data-download-markdown]')) {
      const doc = byId.get(currentId);
      const url = URL.createObjectURL(
        new Blob([doc.markdown], { type: 'text/markdown;charset=utf-8' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = doc.source.split('/').pop();
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify('Markdown download started');
    }
    if (target.matches('.diagram-zoom')) {
      const figure = target.closest('.diagram');
      const expanded = figure.classList.toggle('expanded');
      document.body.classList.toggle('diagram-open', expanded);
      target.setAttribute('aria-expanded', String(expanded));
      target.setAttribute('aria-label', expanded ? 'Close diagram' : 'Expand diagram');
      target.innerHTML = `${icon(expanded ? 'minimize-2' : 'maximize-2')} ${expanded ? 'Close' : 'Expand'}`;
    }
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search(searchInput.value), 80);
  });

  searchDialog.addEventListener('click', (event) => {
    if (event.target === searchDialog) closeSearch();
  });
  searchDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeSearch();
  });
  searchDialog.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
    const links = [...results.querySelectorAll('a')];
    if (!links.length) return;
    if (event.key === 'Enter') {
      if (event.target === searchInput) {
        event.preventDefault();
        (links[searchIndex] || links[0]).click();
      }
      return;
    }
    event.preventDefault();
    searchIndex =
      event.key === 'ArrowDown'
        ? (searchIndex + 1) % links.length
        : searchIndex === -1
          ? links.length - 1
          : (searchIndex - 1 + links.length) % links.length;
    for (const [index, link] of links.entries())
      link.dataset.active = String(index === searchIndex);
    links[searchIndex].focus();
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      searchDialog.open ? closeSearch() : openSearch();
    }
    if (event.key === 'Escape') {
      const expanded = document.querySelector('.diagram.expanded');
      if (expanded) {
        const button = expanded.querySelector('.diagram-zoom');
        expanded.classList.remove('expanded');
        document.body.classList.remove('diagram-open');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-label', 'Expand diagram');
        button.innerHTML = `${icon('maximize-2')} Expand`;
        button.focus();
      }
    }
    if (event.key === 'Escape' && document.body.classList.contains('menu-open')) {
      closeMenu();
      document.querySelector('.mobile-menu').focus();
    }
    if (event.key === 'Tab' && document.body.classList.contains('menu-open')) {
      const focusable = [...sidebar.querySelectorAll('button, a, summary')].filter(
        (item) => item.getClientRects().length,
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  const themeToggle = document.querySelector('.theme-toggle');
  function updateThemeButton() {
    const dark = document.documentElement.dataset.theme === 'dark';
    themeToggle.innerHTML = icon(dark ? 'sun' : 'moon');
    themeToggle.setAttribute(
      'aria-label',
      dark ? 'Switch to light theme' : 'Switch to dark theme',
    );
  }
  themeToggle.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('bitbots-docs-theme', theme);
    } catch {
      /* File-mode or private storage may be unavailable. */
    }
    updateThemeButton();
  });
  updateThemeButton();
  window.matchMedia('(min-width: 821px)').addEventListener('change', (event) => {
    if (event.matches) closeMenu();
  });
  window.addEventListener('hashchange', navigate);
  navigate();
})();
