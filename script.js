// ==UserScript==
// @name         Ficbook Downloader — EPUB & FB2
// @namespace    https://github.com/kaihotabito/ficbook-downloader/
// @version      1.0
// @description  Скачивание фанфиков с Ficbook в EPUB и FB2.
// @author       kaihotabito
// @match        https://ficbook.net/readfic/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ==========================================
  // 1) Настройки / CSS (EPUB)
  // ==========================================
  const EPUB_CSS = `
    body { font-family: serif; line-height: 1.5; margin: 0; padding: 2%; background: #fff; color: #000; }
    h2.chapter-title { text-align: center; margin: 2em 0; page-break-before: always; font-weight: bold; font-size: 1.5em; }
    p { margin: 0; text-indent: 1.5em; text-align: justify; }
    p.no-indent { text-indent: 0; }
    p.empty-line { height: 1.2em; text-indent: 0; }

    .align-center { text-align: center !important; text-indent: 0 !important; }
    .align-right  { text-align: right  !important; text-indent: 0 !important; }
    .align-left   { text-align: left   !important; text-indent: 0 !important; }
    .align-justify{ text-align: justify!important; }

    .author-note { border-top: 1px solid #ccc; border-bottom: 1px solid #ccc; padding: 10px; margin: 20px 0; font-size: 0.95em; background: #f9f9f9; }
    .author-note strong { display: block; margin-bottom: 6px; font-style: normal; }
    .author-note p { text-indent: 0; margin-bottom: 0.5em; text-align: left; }

    .info-page { text-align: left; font-family: sans-serif; }
    .info-title { text-align: center; font-size: 1.8em; font-weight: bold; margin-bottom: 0.4em; }
    .info-author { text-align: center; font-size: 1.2em; margin-bottom: 1.6em; font-style: italic; }
    .info-section { margin-bottom: 1em; }
    .info-label { font-weight: bold; }

    .tag-container { margin-top: 6px; line-height: 2em; }
    span.tag { display: inline-block; background: #f0e6d2; color: #4a3c31; padding: 2px 8px; margin-right: 6px; margin-bottom: 6px; border-radius: 4px; font-size: 0.85em; border: 1px solid #dcc; }
    span.tag.adult { background: #e6d2d2; color: #500; }

    blockquote { margin: 1em 0 1em 1.5em; padding-left: 1em; border-left: 2px solid #bbb; }
    pre { white-space: pre-wrap; font-family: monospace; font-size: 0.95em; background: #f6f6f6; padding: 10px; border-radius: 6px; }
    .u { text-decoration: underline; }
    .strike { text-decoration: line-through; }
    a { color: #0000EE; text-decoration: none; }
  `;

  // ==========================================
  // 2) Вспомогательные
  // ==========================================
  function escapeXml(v) {
    const s = String(v ?? '');
    return s.replace(/[<>&'"]/g, (c) => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '\'': return '&apos;';
        case '"': return '&quot;';
        default: return c;
      }
    });
  }

  function safeFilename(s) {
    return String(s ?? '')
      .replace(/[\\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180) || 'ficbook';
  }

  function uuid() {
    try {
      if (crypto?.randomUUID) return crypto.randomUUID();
    } catch (_) {}
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  }

  function decodeAwayUrl(href) {
    try {
      const u = new URL(href, location.href);
      if (u.pathname === '/away' && u.searchParams.has('url')) {
        return decodeURIComponent(u.searchParams.get('url') || href);
      }
    } catch (_) {}
    return href;
  }

  function normalizeText(t) {
    // NBSP -> space, trim end; leading indent NBSP removed later at paragraph start
    return String(t ?? '').replace(/\u00A0/g, ' ').replace(/\r\n/g, '\n');
  }

  function isProbablyAllParts() {
    return !!document.getElementById('all-parts-content');
  }

  function goToAllParts() {
    const base = location.href.split('#')[0].split('?')[0].replace(/\/$/, '');
    const target = /\/all-parts$/.test(base) ? base : `${base}/all-parts`;
    location.href = target;
  }

  // ==========================================
  // 3) Парсинг страницы (meta + главы)
  // ==========================================
  function parseStory() {
    const container = document.getElementById('all-parts-content');
    if (!container) return null;

    const meta = {
      title: (document.querySelector('h1.heading')?.innerText || '').trim() || 'Fanfic',
      author: (document.querySelector('.creator-username')?.innerText || '').trim() || 'Unknown',
      fandoms: [],
      pairings: [],
      size: '',
      genres: [],
      warnings: [],
      otherTags: [],
      tagsAll: [], // общий плоский список (для выдачи)
      descriptionNodes: null,
      authorNoteNodes: null,
      dedicationNodes: null,
      url: location.href.split('#')[0],
    };

    const hat = document.querySelector('.fanfic-hat');
    if (hat) {
      // Разметка в "шапке" типично: .mb-10 + <strong>Лейбл:</strong> + контент
      const blocks = hat.querySelectorAll('.description .mb-10');
      blocks.forEach((div) => {
        const label = (div.querySelector('strong')?.innerText || '').trim();
        const labelNorm = label.replace(/\s+/g, ' ').toLowerCase();

        const tagAnchors = Array.from(div.querySelectorAll('.tags a.tag'));
        const tags = tagAnchors.map(a => ({
          text: (a.innerText || '').trim(),
          isAdult: a.classList.contains('tag-adult')
        })).filter(t => t.text);

        if (labelNorm.includes('фэндом')) {
          meta.fandoms = Array.from(div.querySelectorAll('a')).map(a => (a.innerText || '').trim()).filter(Boolean);
        } else if (labelNorm.includes('пэйринг')) {
          meta.pairings = Array.from(div.querySelectorAll('a')).map(a => (a.innerText || '').trim()).filter(Boolean);
        } else if (labelNorm.includes('размер')) {
          const clone = div.cloneNode(true);
          const st = clone.querySelector('strong');
          if (st) st.remove();
          meta.size = (clone.innerText || '').trim().replace(/^[:\s]+/, '');
        } else if (labelNorm.includes('жанр')) {
          meta.genres = tags.map(t => t.text);
        } else if (labelNorm.includes('предупрежден')) {
          meta.warnings = tags.map(t => t.text);
        } else if (labelNorm.includes('другие метки')) {
          meta.otherTags = tags.map(t => t.text);
        } else if (labelNorm.includes('описание')) {
          meta.descriptionNodes = div.querySelector('.urlized-links') || div.querySelector('[itemprop="description"]') || null;
        } else if (labelNorm.includes('примечани')) {
          meta.authorNoteNodes = div.querySelector('.urlized-links') || null;
        } else if (labelNorm.includes('посвящ')) {
          meta.dedicationNodes = div.querySelector('.urlized-links') || null;
        }

        // общий список тегов (с признаком adult)
        if (tags.length) {
          tags.forEach(t => meta.tagsAll.push(t));
        }
      });
    }

    // Уникализируем tagsAll по тексту
    {
      const seen = new Set();
      meta.tagsAll = meta.tagsAll.filter(t => {
        const k = t.text.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    // Главы (all-parts)
    const chapters = [];
    let current = null;

    const pushCurrent = () => {
      if (!current) return;
      if (current.contentNode || current.noteTopNode || current.noteBottomNode) chapters.push(current);
    };

    const children = Array.from(container.children);
    for (const node of children) {
      // Новая глава: title-area, в которой реально есть h2 (первый title-area — просто ссылка "Вернуться", его пропускаем)
      if (node.classList.contains('title-area') && node.querySelector('h2')) {
        pushCurrent();
        current = {
          title: (node.querySelector('h2')?.innerText || '').trim() || 'Глава',
          noteTopNode: null,
          contentNode: null,
          noteBottomNode: null,
        };
        continue;
      }

      if (!current) continue;

      if (node.classList.contains('part-comment-top')) {
        current.noteTopNode = node.querySelector('.urlized-links') || node;
        continue;
      }

      if (node.classList.contains('part_text')) {
        current.contentNode = node;
        continue;
      }

      if (node.classList.contains('part-comment-bottom')) {
        current.noteBottomNode = node.querySelector('.urlized-links') || node;
        continue;
      }
    }
    pushCurrent();

    return { ...meta, chapters };
  }

  // ==========================================
  // 4) Конвертация DOM -> XHTML (EPUB), без картинок
  // ==========================================
  const BLOCK_TAGS = new Set(['P','DIV','BLOCKQUOTE','PRE','H1','H2','H3','H4','H5','H6','UL','OL','LI','HR']);

  function cloneAndSanitize(root) {
    const el = root.cloneNode(true);

    // удалить явно мусорное
    el.querySelectorAll('script, style, button, .copy-button, .hidden').forEach(n => n.remove());

    // удалить картинки / picture / source / svg (нам картинки не нужны)
    el.querySelectorAll('img, picture, source, svg').forEach(n => n.remove());

    // подчистить атрибуты (сильно снижает шанс невалидного XHTML)
    el.querySelectorAll('*').forEach(n => {
      // оставим только href у ссылок
      const tag = n.tagName?.toUpperCase?.() || '';
      const href = tag === 'A' ? n.getAttribute('href') : null;

      // remove all attributes
      Array.from(n.attributes || []).forEach(a => n.removeAttribute(a.name));

      if (tag === 'A' && href) n.setAttribute('href', decodeAwayUrl(href));
    });

    return el;
  }

  function xhtmlInline(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeXml(node.nodeValue || '');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toUpperCase();
    if (tag === 'BR') return '\n';

    // картинки уже удалены, но на всякий
    if (tag === 'IMG' || tag === 'PICTURE' || tag === 'SOURCE' || tag === 'SVG') return '';

    const inner = Array.from(node.childNodes).map(xhtmlInline).join('');

    if (tag === 'A') {
      const href = node.getAttribute('href') || '';
      const safeHref = escapeXml(href);
      return href ? `<a href="${safeHref}">${inner}</a>` : inner;
    }

    if (tag === 'B' || tag === 'STRONG') return `<strong>${inner}</strong>`;
    if (tag === 'I' || tag === 'EM') return `<em>${inner}</em>`;
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') return `<span class="strike">${inner}</span>`;
    if (tag === 'U') return `<span class="u">${inner}</span>`;
    if (tag === 'SUP') return `<sup>${inner}</sup>`;
    if (tag === 'SUB') return `<sub>${inner}</sub>`;
    if (tag === 'CODE') return `<code>${inner}</code>`;

    // span и всё неизвестное — просто раскрываем
    return inner;
  }

  function splitIntoParagraphsFromText(text) {
    // Разбивка по переводам строк (каждый \n — разрыв абзаца; подряд идущие дают empty-line)
    const lines = normalizeText(text).split('\n');
    return lines.map(l => l);
  }

  function xhtmlBlocksFromNode(root, isNote) {
    if (!root) return '';
    const el = cloneAndSanitize(root);

    const out = [];
    let current = '';

    const flush = (forceEmptyLine = false) => {
      const raw = current;
      current = '';

      const cleaned = raw.replace(/^[ \t]+/g, ''); // только пробелы/таб; NBSP мы уже превратили в пробелы
      const trimmed = cleaned.trim();

      if (trimmed.length > 0) {
        out.push(`<p>${trimmed}</p>`);
        return;
      }

      if (forceEmptyLine && !isNote && out.length > 0) {
        out.push(`<p class="empty-line">&#160;</p>`);
      }
    };

    const emitEmptyLine = () => {
      if (!isNote && out.length > 0) out.push(`<p class="empty-line">&#160;</p>`);
    };

    const walk = (node) => {
      if (!node) return;

      if (node.nodeType === Node.TEXT_NODE) {
        const parts = splitIntoParagraphsFromText(node.nodeValue || '');
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) flush(true);
          current += escapeXml(parts[i]);
        }
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName.toUpperCase();

      if (tag === 'BR') {
        flush(true);
        return;
      }

      if (BLOCK_TAGS.has(tag)) {
        // закрыть текущий абзац перед блоком
        flush(false);

        if (tag === 'HR') {
          out.push('<hr />');
          return;
        }

        if (tag === 'PRE') {
          const txt = normalizeText(node.textContent || '').replace(/\n+$/g, '');
          if (txt.trim().length) out.push(`<pre>${escapeXml(txt)}</pre>`);
          return;
        }

        if (tag === 'BLOCKQUOTE') {
          const inner = xhtmlBlocksFromNode(node, isNote);
          if (inner.trim().length) out.push(`<blockquote>${inner}</blockquote>`);
          return;
        }

        if (tag === 'UL' || tag === 'OL') {
          const lis = Array.from(node.querySelectorAll(':scope > li'));
          if (!lis.length) return;
          let idx = 1;
          for (const li of lis) {
            const liTxt = xhtmlInline(li).replace(/\n+/g, ' ').trim();
            if (!liTxt) continue;
            if (tag === 'OL') out.push(`<p class="no-indent">${idx++}. ${liTxt}</p>`);
            else out.push(`<p class="no-indent">• ${liTxt}</p>`);
          }
          return;
        }

        if (tag === 'LI') {
          const liTxt = xhtmlInline(node).replace(/\n+/g, ' ').trim();
          if (liTxt) out.push(`<p class="no-indent">• ${liTxt}</p>`);
          return;
        }

        if (tag.startsWith('H')) {
          const hTxt = xhtmlInline(node).replace(/\n+/g, ' ').trim();
          if (hTxt) out.push(`<p class="align-center no-indent"><strong>${hTxt}</strong></p>`);
          return;
        }

        // P / DIV — прогоняем детей как поток
        Array.from(node.childNodes).forEach(walk);
        flush(false);
        return;
      }

      // INLINE
      current += xhtmlInline(node);
    };

    Array.from(el.childNodes).forEach(walk);
    flush(false);

    // В примечаниях убираем пустые хвосты
    if (isNote) {
      while (out.length && out[out.length - 1].includes('empty-line')) out.pop();
    }

    return out.join('\n');
  }

  // ==========================================
  // 5) Сборка EPUB (валиднее, standard OEBPS)
  // ==========================================
  async function buildEpub(data) {
    const bookUuid = uuid();
    const bookId = `urn:uuid:${bookUuid}`;
    const now = new Date();
    const isoDate = now.toISOString().slice(0, 10);

    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

    const metaInf = zip.folder('META-INF');
    metaInf.file('container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

    const oebps = zip.folder('OEBPS');
    oebps.file('style.css', EPUB_CSS);

    const tagsHtml = (data.tagsAll || [])
      .map(t => `<span class="tag ${t.isAdult ? 'adult' : ''}">${escapeXml(t.text)}</span>`)
      .join('\n');

    const descHTML = data.descriptionNodes ? xhtmlBlocksFromNode(data.descriptionNodes, true) : '';
    const authorNoteHTML = data.authorNoteNodes ? xhtmlBlocksFromNode(data.authorNoteNodes, true) : '';
    const dedicationHTML = data.dedicationNodes ? xhtmlBlocksFromNode(data.dedicationNodes, true) : '';

    const safeUrl = escapeXml(data.url);

    const titleXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN"
  "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${escapeXml(data.title)}</title>
  <link rel="stylesheet" href="style.css" type="text/css"/>
</head>
<body>
  <div class="info-page">
    <div class="info-title">${escapeXml(data.title)}</div>
    <div class="info-author">${escapeXml(data.author)}</div>

    <div class="info-section"><span class="info-label">Фэндом:</span> ${escapeXml((data.fandoms || []).join(', '))}</div>
    <div class="info-section"><span class="info-label">Пэйринг:</span> ${escapeXml((data.pairings || []).join(', '))}</div>
    <div class="info-section"><span class="info-label">Размер:</span> ${escapeXml(data.size || '')}</div>

    <div class="info-section">
      <div class="info-label">Метки:</div>
      <div class="tag-container">${tagsHtml}</div>
    </div>

    ${descHTML ? `<hr/><div class="info-section"><div class="info-label">Описание:</div>${descHTML}</div>` : ''}

    ${dedicationHTML ? `<hr/><div class="info-section"><div class="info-label">Посвящение:</div>${dedicationHTML}</div>` : ''}

    ${authorNoteHTML ? `<hr/><div class="info-section"><div class="info-label">Примечания:</div>${authorNoteHTML}</div>` : ''}

    <hr/>
    <div style="margin-top: 16px; font-size: 0.85em; color: #666;">
      Источник: <a href="${safeUrl}">${safeUrl}</a>
    </div>
  </div>
</body>
</html>`;
    oebps.file('title.xhtml', titleXhtml);

    // Manifest & spine
    const items = [];
    const spine = [];

    items.push(`<item id="css" href="style.css" media-type="text/css"/>`);
    items.push(`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);
    items.push(`<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="title"/>`);

    // NCX nav
    const navPoints = [];
    let playOrder = 1;
    navPoints.push(`<navPoint id="navPoint-title" playOrder="${playOrder++}"><navLabel><text>Информация</text></navLabel><content src="title.xhtml"/></navPoint>`);

    data.chapters.forEach((chap, idx) => {
      const id = `chap${idx + 1}`;
      const href = `chapter_${idx + 1}.xhtml`;

      const contentHtml = chap.contentNode ? xhtmlBlocksFromNode(chap.contentNode, false) : '';
      const topHtml = chap.noteTopNode
        ? `<div class="author-note"><strong>Примечание:</strong>${xhtmlBlocksFromNode(chap.noteTopNode, true)}</div>`
        : '';
      const botHtml = chap.noteBottomNode
        ? `<div class="author-note"><strong>Примечание:</strong>${xhtmlBlocksFromNode(chap.noteBottomNode, true)}</div>`
        : '';

      const page = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN"
  "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${escapeXml(chap.title)}</title>
  <link rel="stylesheet" href="style.css" type="text/css"/>
</head>
<body>
  <h2 class="chapter-title">${escapeXml(chap.title)}</h2>
  ${topHtml}
  <div class="chapter-text">${contentHtml}</div>
  ${botHtml}
</body>
</html>`;

      oebps.file(href, page);
      items.push(`<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`);
      spine.push(`<itemref idref="${id}"/>`);
      navPoints.push(`<navPoint id="navPoint-${id}" playOrder="${playOrder++}"><navLabel><text>${escapeXml(chap.title)}</text></navLabel><content src="${href}"/></navPoint>`);
    });

    const plainDesc = data.descriptionNodes ? normalizeText(data.descriptionNodes.textContent || '').trim() : '';
    const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">${escapeXml(bookId)}</dc:identifier>
    <dc:title>${escapeXml(data.title)}</dc:title>
    <dc:creator>${escapeXml(data.author)}</dc:creator>
    <dc:language>ru</dc:language>
    <dc:date>${escapeXml(isoDate)}</dc:date>
    <dc:description>${escapeXml(plainDesc)}</dc:description>
  </metadata>
  <manifest>
    ${items.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spine.join('\n    ')}
  </spine>
</package>`;
    oebps.file('content.opf', opf);

    const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(bookId)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(data.title)}</text></docTitle>
  <navMap>
    ${navPoints.join('\n    ')}
  </navMap>
</ncx>`;
    oebps.file('toc.ncx', ncx);

    return await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
  }

  // ==========================================
  // 6) DOM -> FB2 (хорошая разметка, без картинок)
  // ==========================================
  function fb2Inline(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return escapeXml(normalizeText(node.nodeValue || ''));
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toUpperCase();
    if (tag === 'BR') return '\n';

    // без картинок
    if (tag === 'IMG' || tag === 'PICTURE' || tag === 'SOURCE' || tag === 'SVG') return '';

    const inner = Array.from(node.childNodes).map(fb2Inline).join('');

    if (tag === 'B' || tag === 'STRONG') return `<strong>${inner}</strong>`;
    if (tag === 'I' || tag === 'EM') return `<emphasis>${inner}</emphasis>`;
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') return `<strikethrough>${inner}</strikethrough>`;
    if (tag === 'SUB') return `<sub>${inner}</sub>`;
    if (tag === 'SUP') return `<sup>${inner}</sup>`;
    if (tag === 'CODE') return `<code>${inner}</code>`;

    if (tag === 'A') {
      const hrefRaw = node.getAttribute('href') || '';
      const href = decodeAwayUrl(hrefRaw);
      const safeHref = escapeXml(href);
      return href ? `<a l:href="${safeHref}">${inner}</a>` : inner;
    }

    // span и неизвестное — раскрываем
    return inner;
  }

  function fb2BlocksFromNode(root, isNote) {
    if (!root) return '';
    const el = cloneAndSanitize(root);

    const blocks = [];
    let current = '';
    let lastWasBreak = false;

    const flushParagraph = (allowEmptyLine) => {
      // вычищаем лидирующие пробелы, чтобы не было двойного отступа (Ficbook часто ставит NBSP/пробелы)
      const s = current.replace(/^[ \t]+/g, '');
      current = '';

      const text = s.replace(/\s+$/g, '');
      const trimmed = text.trim();

      if (trimmed.length) {
        blocks.push(`<p>${trimmed}</p>`);
        lastWasBreak = false;
        return;
      }

      if (allowEmptyLine && !isNote && blocks.length) {
        blocks.push(`<empty-line/>`);
        lastWasBreak = true;
      }
    };

    const walk = (node) => {
      if (!node) return;

      if (node.nodeType === Node.TEXT_NODE) {
        const parts = normalizeText(node.nodeValue || '').split('\n');
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) flushParagraph(true);
          current += escapeXml(parts[i]);
        }
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName.toUpperCase();

      if (tag === 'BR') {
        flushParagraph(true);
        return;
      }

      if (BLOCK_TAGS.has(tag)) {
        flushParagraph(false);

        if (tag === 'HR') {
          if (!isNote && blocks.length && !lastWasBreak) blocks.push('<empty-line/>');
          lastWasBreak = true;
          return;
        }

        if (tag === 'PRE') {
          const txt = normalizeText(node.textContent || '').replace(/\n+$/g, '');
          if (txt.trim().length) {
            const lines = txt.split('\n');
            lines.forEach((ln) => {
              const line = ln.replace(/\u00A0/g, ''); // в code обычно не нужно NBSP
              blocks.push(`<p><code>${escapeXml(line)}</code></p>`);
            });
          }
          lastWasBreak = false;
          return;
        }

        if (tag === 'BLOCKQUOTE') {
          const inner = fb2BlocksFromNode(node, isNote).trim();
          if (inner) blocks.push(`<cite>${inner}</cite>`);
          lastWasBreak = false;
          return;
        }

        if (tag === 'UL' || tag === 'OL') {
          const lis = Array.from(node.querySelectorAll(':scope > li'));
          let idx = 1;
          for (const li of lis) {
            const liTxt = fb2Inline(li).replace(/\n+/g, ' ').trim();
            if (!liTxt) continue;
            if (tag === 'OL') blocks.push(`<p>${idx++}. ${liTxt}</p>`);
            else blocks.push(`<p>• ${liTxt}</p>`);
          }
          lastWasBreak = false;
          return;
        }

        if (tag === 'LI') {
          const liTxt = fb2Inline(node).replace(/\n+/g, ' ').trim();
          if (liTxt) blocks.push(`<p>• ${liTxt}</p>`);
          lastWasBreak = false;
          return;
        }

        if (tag.startsWith('H')) {
          const hTxt = fb2Inline(node).replace(/\n+/g, ' ').trim();
          if (hTxt) blocks.push(`<subtitle>${hTxt}</subtitle>`);
          lastWasBreak = false;
          return;
        }

        // P / DIV — прогоняем детей
        Array.from(node.childNodes).forEach(walk);
        flushParagraph(false);
        return;
      }

      // INLINE
      current += fb2Inline(node);
    };

    Array.from(el.childNodes).forEach(walk);
    flushParagraph(false);

    // чистим хвостовые empty-line в примечаниях/аннотации
    if (isNote) {
      while (blocks.length && blocks[blocks.length - 1] === '<empty-line/>') blocks.pop();
    }

    return blocks.join('\n');
  }

  async function buildFb2(data) {
    const bookUuid = uuid();
    const bookId = `urn:uuid:${bookUuid}`;
    const now = new Date();
    const isoDate = now.toISOString().slice(0, 10);

    // Аннотация: описание + посвящение + примечания + базовые мета
    let annotation = '';

    if (data.descriptionNodes) {
      const a = fb2BlocksFromNode(data.descriptionNodes, true).trim();
      if (a) annotation += a + '\n<empty-line/>\n';
    }
    if (data.dedicationNodes) {
      const d = fb2BlocksFromNode(data.dedicationNodes, true).trim();
      if (d) annotation += `<subtitle>Посвящение</subtitle>\n${d}\n<empty-line/>\n`;
    }
    if (data.authorNoteNodes) {
      const n = fb2BlocksFromNode(data.authorNoteNodes, true).trim();
      if (n) annotation += `<subtitle>Примечания</subtitle>\n${n}\n<empty-line/>\n`;
    }

    annotation += `<p><strong>Фэндом:</strong> ${escapeXml((data.fandoms || []).join(', '))}</p>\n`;
    annotation += `<p><strong>Пэйринг:</strong> ${escapeXml((data.pairings || []).join(', '))}</p>\n`;
    if (data.size) annotation += `<p><strong>Размер:</strong> ${escapeXml(data.size)}</p>\n`;

    const tagFlat = (data.tagsAll || []).map(t => t.text).filter(Boolean);
    if (tagFlat.length) annotation += `<p><strong>Метки:</strong> ${escapeXml(tagFlat.join(', '))}</p>\n`;

    annotation += `<p><strong>Источник:</strong> <a l:href="${escapeXml(data.url)}">${escapeXml(data.url)}</a></p>\n`;

    // Тело
    let body = '';
    for (const chap of data.chapters) {
      body += `<section>\n<title><p>${escapeXml(chap.title)}</p></title>\n`;

      if (chap.noteTopNode) {
        const top = fb2BlocksFromNode(chap.noteTopNode, true).trim();
        if (top) body += `<subtitle>Примечание</subtitle>\n${top}\n<empty-line/>\n`;
      }

      if (chap.contentNode) {
        const txt = fb2BlocksFromNode(chap.contentNode, false).trim();
        if (txt) body += txt + '\n';
      }

      if (chap.noteBottomNode) {
        const bot = fb2BlocksFromNode(chap.noteBottomNode, true).trim();
        if (bot) body += `<empty-line/>\n<subtitle>Примечание</subtitle>\n${bot}\n`;
      }

      body += `</section>\n`;
    }

    const fb2 = `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"
             xmlns:l="http://www.w3.org/1999/xlink">
  <description>
    <title-info>
      <genre>fanfiction</genre>
      <author><nickname>${escapeXml(data.author)}</nickname></author>
      <book-title>${escapeXml(data.title)}</book-title>
      <annotation>
${annotation.trim()}
      </annotation>
      <lang>ru</lang>
      <date value="${escapeXml(isoDate)}">${escapeXml(isoDate)}</date>
    </title-info>
    <document-info>
      <author><nickname>Ficbook Downloader Script</nickname></author>
      <date value="${escapeXml(isoDate)}">${escapeXml(isoDate)}</date>
      <src-url>${escapeXml(data.url)}</src-url>
      <id>${escapeXml(bookId)}</id>
      <version>1.1</version>
    </document-info>
  </description>
  <body>
${body.trim()}
  </body>
</FictionBook>`;

    return new Blob([fb2], { type: 'text/xml;charset=utf-8' });
  }

  // ==========================================
  // 7) UI (кнопки + устойчивость к перерендеру)
  // ==========================================
  function addStylesOnce() {
    if (document.getElementById('kaiho-ficdl-style')) return;
    const st = document.createElement('style');
    st.id = 'kaiho-ficdl-style';
    st.textContent = `
      .kaiho-ficdl-btn { margin-left: 10px; }
      .kaiho-ficdl-btn .description { opacity: .9; }
    `;
    document.head.appendChild(st);
  }

  function createBtn(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-with-description btn-success kaiho-ficdl-btn';
    btn.dataset.kaihoFicdl = '1';
    btn.innerHTML = `<span class="main-info">${label}</span><span class="description">Скачать</span>`;
    btn.addEventListener('click', onClick, { passive: false });
    return btn;
  }

  async function handleDownload(format, btn) {
    if (!isProbablyAllParts()) {
      if (confirm("Для корректного скачивания открой страницу «Все части одной лентой» (all-parts). Перейти?")) {
        goToAllParts();
      }
      return;
    }

    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="main-info">...</span><span class="description">Подготовка</span>`;

    try {
      const data = parseStory();
      if (!data) throw new Error('Не удалось найти контент (all-parts-content).');
      if (!data.chapters?.length) throw new Error('Не удалось найти главы.');

      let blob, ext;
      if (format === 'epub') {
        blob = await buildEpub(data);
        ext = 'epub';
      } else {
        blob = await buildFb2(data);
        ext = 'fb2';
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeFilename(data.title)} - ${safeFilename(data.author)}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      btn.innerHTML = `<span class="main-info">OK</span><span class="description">Готово</span>`;
    } catch (e) {
      console.error(e);
      alert('Ошибка: ' + (e?.message || e));
      btn.innerHTML = `<span class="main-info">Err</span><span class="description">Ошибка</span>`;
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = original;
      }, 1500);
    }
  }

  function injectButtons() {
    addStylesOnce();

    const btnContainer = document.querySelector('.hat-actions-container .d-flex');
    if (!btnContainer) return false;

    // защита от дублей
    if (btnContainer.querySelector('button[data-kaiho-ficdl="1"]')) return true;

    const btnEpub = createBtn('EPUB', (e) => {
      e.preventDefault();
      handleDownload('epub', e.currentTarget);
    });

    const btnFb2 = createBtn('FB2', (e) => {
      e.preventDefault();
      handleDownload('fb2', e.currentTarget);
    });

    btnContainer.appendChild(btnEpub);
    btnContainer.appendChild(btnFb2);
    return true;
  }

  function init() {
    injectButtons();

    // На случай, если сайт перерисовал шапку (SPA/вьюшки)
    const obs = new MutationObserver(() => injectButtons());
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  init();
})();
