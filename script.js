// ==UserScript==
// @name         Ficbook Downloader — EPUB & FB2
// @namespace    https://github.com/kaihotabito/figbook-downloader/
// @version      2.0
// @description  Скачивание фанфиков с Ficbook в EPUB и FB2
// @author       kaihotabito
// @match        https://ficbook.net/readfic/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ==========================================
  // 1) CSS (EPUB)
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
  // 2) Утилиты
  // ==========================================
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ==========================================
  // 2.0) Настройки (EPUB)
  // ==========================================
  // На некоторых окружениях ZIP-упаковка больших книг может занимать заметное время и/или фризить UI.
  // Ниже включается расширенная диагностика.
  function isDebugEnabled() {
    try {
      if (localStorage.getItem('ficdl_debug')) return true;
    } catch (_) {}

    // Фоллбек, если storage недоступен (private mode / ограничения браузера / политики сайта):
    // можно включить из консоли страницы: window.__ficdl_debug = true
    try {
      const win = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
      if (win && win.__ficdl_debug) return true;
    } catch (_) {}

    return false;
  }

  function getSettingNumber(key, def, { min = -Infinity, max = Infinity } = {}) {
    let v = null;
    try { v = localStorage.getItem(key); } catch (_) {}
    if (v == null) {
      try {
        const win = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
        v = win ? win[`__${key}`] : null;
      } catch (_) {}
    }
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
  }

  function getSettingBool(key, def = false) {
    let v = null;
    try { v = localStorage.getItem(key); } catch (_) {}
    if (v == null) {
      try {
        const win = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
        v = win ? win[`__${key}`] : null;
      } catch (_) {}
    }
    if (v == null) return def;
    if (typeof v === 'boolean') return v;
    const s = String(v).toLowerCase().trim();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
    return def;
  }

  // ==========================================
  // 2.0.1) Minimal ZIP (STORE) for EPUB
  // ==========================================
  const _crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c = _crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function u16le(n) {
    const a = new Uint8Array(2);
    a[0] = n & 0xFF;
    a[1] = (n >>> 8) & 0xFF;
    return a;
  }

  function u32le(n) {
    const a = new Uint8Array(4);
    a[0] = n & 0xFF;
    a[1] = (n >>> 8) & 0xFF;
    a[2] = (n >>> 16) & 0xFF;
    a[3] = (n >>> 24) & 0xFF;
    return a;
  }

  function concatBytes(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  async function buildZipStoreBlob(entries, { onProgress } = {}) {
    const enc = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
    const encodeUtf8 = (s) => {
      if (enc) return enc.encode(String(s ?? ''));
      const bin = unescape(encodeURIComponent(String(s ?? '')));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xFF;
      return out;
    };
    const files = [];

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const name = String(e.name);
      const nameBytes = encodeUtf8(name);
      const dataBytes = (e.data instanceof Uint8Array) ? e.data : encodeUtf8(e.data);
      const crc = crc32(dataBytes);

      files.push({ name, nameBytes, dataBytes, crc, size: dataBytes.length, offset: 0 });
      if (onProgress) onProgress({ phase: 'zip_files', current: i + 1, total: entries.length, name });
      if ((i + 1) % 10 === 0) await sleep(0);
    }

    const outParts = [];
    let offset = 0;

    // Local headers + file data
    for (const f of files) {
      f.offset = offset;
      // Local file header
      // signature + ver + flags(UTF-8) + method + time/date + crc + sizes + nameLen + extraLen
      const header = concatBytes([
        u32le(0x04034b50),
        u16le(20),
        u16le(0x0800),
        u16le(0),
        u16le(0),
        u16le(0),
        u32le(f.crc),
        u32le(f.size),
        u32le(f.size),
        u16le(f.nameBytes.length),
        u16le(0),
        f.nameBytes
      ]);

      outParts.push(header, f.dataBytes);
      offset += header.length + f.dataBytes.length;
      if ((outParts.length / 2) % 10 === 0) await sleep(0);
    }

    // Central directory
    const cdStart = offset;
    const cdParts = [];
    for (const f of files) {
      const cd = concatBytes([
        u32le(0x02014b50),
        u16le(20),
        u16le(20),
        u16le(0x0800),
        u16le(0),
        u16le(0),
        u16le(0),
        u32le(f.crc),
        u32le(f.size),
        u32le(f.size),
        u16le(f.nameBytes.length),
        u16le(0),
        u16le(0),
        u16le(0),
        u16le(0),
        u32le(0),
        u32le(f.offset),
        f.nameBytes
      ]);
      cdParts.push(cd);
      offset += cd.length;
    }
    const cdBytes = concatBytes(cdParts);
    outParts.push(cdBytes);

    const cdSize = cdBytes.length;
    const eocd = concatBytes([
      u32le(0x06054b50),
      u16le(0),
      u16le(0),
      u16le(files.length),
      u16le(files.length),
      u32le(cdSize),
      u32le(cdStart),
      u16le(0)
    ]);
    outParts.push(eocd);

    if (onProgress) onProgress({ phase: 'zip_done' });
    return new Blob(outParts, { type: 'application/epub+zip' });
  }

  // Как часто уступать поток при построении XHTML глав (уменьшает «фриз» UI на больших книгах)
  const EPUB_CHAPTER_YIELD_EVERY = 5;

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

  function normalizeText(t) {
    return String(t ?? '').replace(/\u00A0/g, ' ').replace(/\r\n/g, '\n');
  }

  function uuidUrn() {
    try {
      const id = crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
      return `urn:uuid:${id}`;
    } catch (_) {
      return `urn:uuid:${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    }
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

  function isProbablyAllParts(doc = document) {
    return !!doc.getElementById('all-parts-content');
  }

  function goToAllParts() {
    const base = location.href.split('#')[0].split('?')[0].replace(/\/$/, '');
    const target = /\/all-parts$/.test(base) ? base : `${base}/all-parts`;
    location.href = target;
  }

  function getFicIdFromUrl(u = location.href) {
    try {
      const url = new URL(u, location.origin);
      const m = url.pathname.match(/^\/readfic\/([^\/?#]+)/);
      return m ? m[1] : null;
    } catch (_) {
      const m = location.pathname.match(/^\/readfic\/([^\/?#]+)/);
      return m ? m[1] : null;
    }
  }

  function getPartIdFromUrl(u = location.href) {
    try {
      const url = new URL(u, location.origin);
      const m = url.pathname.match(/^\/readfic\/[^\/?#]+\/(\d+)(?:$|\/)/);
      return m ? m[1] : null;
    } catch (_) {
      const m = location.pathname.match(/^\/readfic\/[^\/?#]+\/(\d+)(?:$|\/)/);
      return m ? m[1] : null;
    }
  }

  function getBaseFicUrl(u = location.href) {
    const ficId = getFicIdFromUrl(u);
    return ficId ? `${location.origin}/readfic/${ficId}` : location.href.split('#')[0];
  }

  function isPremiumUser() {
    const win = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    return !!(win.ficbook?.userInfo?.isPremium);
  }

  // ==========================================
  // 2.1) Toast
  // ==========================================
  function toast(msg) {
    const id = 'kaiho-ficdl-toast';
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.cssText = `
        position: fixed; left: 16px; bottom: 16px; z-index: 999999;
        background: rgba(0,0,0,.82); color: #fff; padding: 10px 12px;
        border-radius: 10px; font-size: 13px; line-height: 1.25;
        max-width: 70vw; box-shadow: 0 10px 30px rgba(0,0,0,.25);
        user-select: none;
      `;
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.style.display = 'none'; }, 1600);
  }

  // ==========================================
  // 2.2) IndexedDB Cache (главы)
  // ==========================================
  const DB_NAME = 'ficdl_cache';
  const DB_VERSION = 1;
  const STORE_CHAPTERS = 'chapters';

  function hasIDB() {
    return typeof indexedDB !== 'undefined';
  }

  function idbReq(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB error'));
    });
  }

  let _dbPromise = null;
  function openDb() {
    if (!hasIDB()) return Promise.resolve(null);
    if (_dbPromise) return _dbPromise;

    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_CHAPTERS)) {
          db.createObjectStore(STORE_CHAPTERS, { keyPath: 'key' }); // key = `${ficId}::${partId}`
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open error'));
    });

    return _dbPromise;
  }

  function chapterKey(ficId, partId) {
    return `${ficId}::${partId}`;
  }

  async function dbPutChapter(ficId, partId, value) {
    const db = await openDb();
    if (!db) return false;

    const tx = db.transaction(STORE_CHAPTERS, 'readwrite');
    const store = tx.objectStore(STORE_CHAPTERS);
    store.put({ key: chapterKey(ficId, partId), ...value });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('IndexedDB tx error'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB tx abort'));
    });
    return true;
  }

  async function dbGetChapter(ficId, partId) {
    const db = await openDb();
    if (!db) return null;

    const tx = db.transaction(STORE_CHAPTERS, 'readonly');
    const store = tx.objectStore(STORE_CHAPTERS);
    const res = await idbReq(store.get(chapterKey(ficId, partId)));
    return res || null;
  }

  async function dbDeleteFic(ficId) {
    const db = await openDb();
    if (!db) return false;

    const tx = db.transaction(STORE_CHAPTERS, 'readwrite');
    const store = tx.objectStore(STORE_CHAPTERS);

    await new Promise((resolve, reject) => {
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return resolve();
        const k = String(cursor.key || '');
        if (k.startsWith(ficId + '::')) cursor.delete();
        cursor.continue();
      };
      req.onerror = () => reject(req.error || new Error('cursor error'));
    });

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('tx error'));
      tx.onabort = () => reject(tx.error || new Error('tx abort'));
    });

    return true;
  }

  // fallback (на крайний случай) — small localStorage cache
  const LS_PREFIX = 'ficdl_ls:';
  function lsKey(ficId) { return LS_PREFIX + ficId; }

  function lsGet(ficId) {
    try {
      const raw = localStorage.getItem(lsKey(ficId));
      const obj = raw ? JSON.parse(raw) : null;
      return obj && obj.chapters ? obj : { chapters: {} };
    } catch (_) { return { chapters: {} }; }
  }

  function lsPutChapter(ficId, partId, value) {
    const obj = lsGet(ficId);
    obj.chapters[partId] = value;
    try {
      localStorage.setItem(lsKey(ficId), JSON.stringify(obj));
      return true;
    } catch (e) {
      console.warn('localStorage quota exceeded', e);
      return false;
    }
  }

  function lsGetChapter(ficId, partId) {
    const obj = lsGet(ficId);
    return obj.chapters[partId] || null;
  }

  function lsClear(ficId) {
    localStorage.removeItem(lsKey(ficId));
  }

  async function putChapter(ficId, partId, value) {
    if (hasIDB()) {
      try { return await dbPutChapter(ficId, partId, value); } catch (e) { console.warn(e); }
    }
    return lsPutChapter(ficId, partId, value);
  }

  async function getChapter(ficId, partId) {
    if (hasIDB()) {
      try { return await dbGetChapter(ficId, partId); } catch (e) { console.warn(e); }
    }
    return lsGetChapter(ficId, partId);
  }

  async function clearFicCache(ficId) {
    if (hasIDB()) {
      try { await dbDeleteFic(ficId); } catch (e) { console.warn(e); }
    }
    lsClear(ficId);
  }

  // ==========================================
  // 3) Парсинг meta + TOC (оглавление)
  // ==========================================
  function isTocPage(doc = document) {
    return !!doc.querySelector('.list-of-fanfic-parts');
  }

  function parseTocParts(doc = document) {
    const anchors = Array.from(doc.querySelectorAll('.list-of-fanfic-parts a.part-link'));
    return anchors
      .filter(a => !a.classList.contains('line-link'))
      .map(a => {
        const href = a.getAttribute('href') || '';
        if (/\/all-parts(?:$|[?#/])/.test(href)) return null;

        const abs = new URL(href, location.href).toString();
        // ВАЖНО: в URL вида /readfic/<ficId>/<partId> нельзя брать "первую группу цифр",
        // иначе partId станет равен ficId и все главы будут перетираться в кэше.
        const partId = getPartIdFromUrl(abs);

        const title = (
          a.querySelector('h3')?.textContent ||
          a.querySelector('.part-title h3')?.textContent ||
          a.textContent ||
          ''
        ).trim() || (partId ? `Глава ${partId}` : 'Глава');

        return partId ? { partId, title, url: abs.split('#')[0] } : null;
      })
      .filter(Boolean);
  }

  function parseMeta(doc = document) {
    const meta = {
      title: (doc.querySelector('h1.heading')?.innerText || '').trim() || 'Fanfic',
      author: (doc.querySelector('.creator-username')?.innerText || '').trim() || 'Unknown',
      fandoms: [],
      pairings: [],
      size: '',
      genres: [],
      warnings: [],
      otherTags: [],
      tagsAll: [],
      descriptionNodes: null,
      authorNoteNodes: null,
      dedicationNodes: null,
      url: getBaseFicUrl(),
    };

    const hat = doc.querySelector('.fanfic-hat');
    if (hat) {
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

        if (tags.length) tags.forEach(t => meta.tagsAll.push(t));
      });
    }

    // uniq tagsAll
    const seen = new Set();
    meta.tagsAll = meta.tagsAll.filter(t => {
      const k = t.text.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    return meta;
  }

  async function fetchTocDoc() {
    if (isTocPage(document)) return document;

    const baseUrl = getBaseFicUrl();
    const resp = await fetch(baseUrl, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error(`Не удалось загрузить оглавление (${resp.status})`);
    const txt = await resp.text();
    return new DOMParser().parseFromString(txt, 'text/html');
  }

  // ==========================================
  // 4) Premium: parse all-parts
  // ==========================================
  function parseStoryAllParts(doc = document) {
    const container = doc.getElementById('all-parts-content');
    if (!container) return null;

    const meta = parseMeta(doc);
    meta.url = location.href.split('#')[0];

    const chapters = [];
    let current = null;

    const push = () => {
      if (!current) return;
      if (current.contentNode || current.noteTopNode || current.noteBottomNode) chapters.push(current);
    };

    const children = Array.from(container.children);
    for (const node of children) {
      if (node.classList.contains('title-area') && node.querySelector('h2')) {
        push();
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
    push();

    return { ...meta, chapters };
  }

  // ==========================================
  // 5) DOM -> XHTML/FB2 (sanitize)
  // ==========================================
  const BLOCK_TAGS = new Set(['P','DIV','BLOCKQUOTE','PRE','H1','H2','H3','H4','H5','H6','UL','OL','LI','HR']);

  function cloneAndSanitize(root) {
    const el = root.cloneNode(true);

    el.querySelectorAll('script, style, button, .copy-button, .hidden').forEach(n => n.remove());
    el.querySelectorAll('img, picture, source, svg').forEach(n => n.remove());

    el.querySelectorAll('*').forEach(n => {
      const tag = n.tagName?.toUpperCase?.() || '';
      const href = tag === 'A' ? n.getAttribute('href') : null;

      Array.from(n.attributes || []).forEach(a => n.removeAttribute(a.name));

      if (tag === 'A' && href) n.setAttribute('href', decodeAwayUrl(href));
    });

    return el;
  }

  function xhtmlInline(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return escapeXml(node.nodeValue || '');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toUpperCase();
    if (tag === 'BR') return '\n';
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

    return inner;
  }

  function splitIntoParagraphsFromText(text) {
    return normalizeText(text).split('\n');
  }

  function xhtmlBlocksFromSanitizedNode(el, isNote) {
    if (!el) return '';

    const out = [];
    let current = '';

    const emptyLine = () => {
      if (!isNote && out.length > 0) out.push(`<p class="empty-line">&#160;</p>`);
    };

    const flush = (allowEmptyLine = false) => {
      const raw = current;
      current = '';

      const cleaned = raw.replace(/^[ \t]+/g, '');
      const trimmed = cleaned.trim();

      if (trimmed.length > 0) {
        out.push(`<p>${trimmed}</p>`);
        return;
      }

      if (allowEmptyLine) emptyLine();
    };

    const appendText = (s) => {
      const parts = splitIntoParagraphsFromText(s);
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) flush(true);
        current += escapeXml(parts[i]);
      }
    };

    const walk = (node) => {
      if (!node) return;

      if (node.nodeType === Node.TEXT_NODE) {
        appendText(node.nodeValue || '');
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toUpperCase();

      if (tag === 'BR') { flush(true); return; }

      if (BLOCK_TAGS.has(tag)) {
        flush(false);

        if (tag === 'HR') { out.push('<hr />'); return; }

        if (tag === 'PRE') {
          const txt = normalizeText(node.textContent || '').replace(/\n+$/g, '');
          if (txt.trim().length) out.push(`<pre>${escapeXml(txt)}</pre>`);
          return;
        }

        if (tag === 'BLOCKQUOTE') {
          // ВАЖНО: node уже находится в sanitized дереве, поэтому повторная cloneAndSanitize здесь избыточна
          // и на больших текстах даёт квадратичное время.
          const inner = xhtmlBlocksFromSanitizedNode(node, isNote);
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

        Array.from(node.childNodes).forEach(walk);
        flush(false);
        return;
      }

      // INLINE
      current += xhtmlInline(node);
    };

    Array.from(el.childNodes).forEach(walk);
    flush(false);

    if (isNote) {
      while (out.length && out[out.length - 1].includes('empty-line')) out.pop();
    }

    return out.join('\n');
  }

  function xhtmlBlocksFromNode(root, isNote) {
    if (!root) return '';
    const el = cloneAndSanitize(root);
    return xhtmlBlocksFromSanitizedNode(el, isNote);
  }

  function fb2Inline(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return escapeXml(normalizeText(node.nodeValue || ''));
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toUpperCase();
    if (tag === 'BR') return '\n';
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

    return inner;
  }

  function fb2BlocksFromNode(root, isNote) {
    if (!root) return '';
    const el = cloneAndSanitize(root);

    const blocks = [];
    let current = '';
    let lastWasBreak = false;

    const emptyLine = () => {
      if (!isNote && blocks.length) {
        blocks.push(`<empty-line/>`);
        lastWasBreak = true;
      }
    };

    const flushParagraph = (allowEmptyLine) => {
      const s = current.replace(/^[ \t]+/g, '');
      current = '';

      const text = s.replace(/\s+$/g, '');
      const trimmed = text.trim();

      if (trimmed.length) {
        blocks.push(`<p>${trimmed}</p>`);
        lastWasBreak = false;
        return;
      }

      if (allowEmptyLine) emptyLine();
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

      if (tag === 'BR') { flushParagraph(true); return; }

      if (BLOCK_TAGS.has(tag)) {
        flushParagraph(false);

        if (tag === 'HR') { emptyLine(); return; }

        if (tag === 'PRE') {
          const txt = normalizeText(node.textContent || '').replace(/\n+$/g, '');
          if (txt.trim().length) {
            const lines = txt.split('\n');
            lines.forEach((ln) => {
              const line = ln.replace(/\u00A0/g, '');
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

        Array.from(node.childNodes).forEach(walk);
        flushParagraph(false);
        return;
      }

      current += fb2Inline(node);
    };

    Array.from(el.childNodes).forEach(walk);
    flushParagraph(false);

    if (isNote) {
      while (blocks.length && blocks[blocks.length - 1] === '<empty-line/>') blocks.pop();
    }

    return blocks.join('\n');
  }

  function elementFromHtml(html) {
    const d = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    return d.body.firstElementChild;
  }

  // ==========================================
  // 6) EPUB / FB2 builders
  // ==========================================
  async function buildEpub(data, { onProgress } = {}) {
    const DEBUG = isDebugEnabled();
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const bookId = uuidUrn();
    const isoDate = new Date().toISOString().slice(0, 10);

    if (DEBUG) console.log('[ficdl] EPUB build start', { title: data?.title, chapters: (data?.chapters || []).length });

    const zipEntries = [];
    zipEntries.push({ name: 'mimetype', data: 'application/epub+zip' }); // must be first and uncompressed
    zipEntries.push({
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
    });
    zipEntries.push({ name: 'OEBPS/style.css', data: EPUB_CSS });

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
    zipEntries.push({ name: 'OEBPS/title.xhtml', data: titleXhtml });

    const items = [];
    const spine = [];
    items.push(`<item id="css" href="style.css" media-type="text/css"/>`);
    items.push(`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);
    items.push(`<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="title"/>`);

    const navPoints = [];
    let playOrder = 1;
    navPoints.push(`<navPoint id="navPoint-title" playOrder="${playOrder++}"><navLabel><text>Информация</text></navLabel><content src="title.xhtml"/></navPoint>`);

    const chaptersArr = (data.chapters || []);
    for (let idx = 0; idx < chaptersArr.length; idx++) {
      const chap = chaptersArr[idx];
      const id = `chap${idx + 1}`;
      const href = `chapter_${idx + 1}.xhtml`;

      const chapT0 = DEBUG ? ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) : 0;
      if (DEBUG) console.log('[ficdl] EPUB chapter start', { idx: idx + 1, total: chaptersArr.length, title: chap?.title });

      const contentHtml = chap.contentNode ? xhtmlBlocksFromNode(chap.contentNode, false) : '';
      const topHtml = chap.noteTopNode
        ? `<div class="author-note"><strong>Примечание:</strong>${xhtmlBlocksFromNode(chap.noteTopNode, true)}</div>`
        : '';
      const botHtml = chap.noteBottomNode
        ? `<div class="author-note"><strong>Примечание:</strong>${xhtmlBlocksFromNode(chap.noteBottomNode, true)}</div>`
        : '';

      if (DEBUG) {
        const chapT1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        console.log('[ficdl] EPUB chapter done', { idx: idx + 1, ms: Math.round(chapT1 - chapT0) });
      }

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

      zipEntries.push({ name: `OEBPS/${href}`, data: page });
      items.push(`<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`);
      spine.push(`<itemref idref="${id}"/>`);
      navPoints.push(`<navPoint id="navPoint-${id}" playOrder="${playOrder++}"><navLabel><text>${escapeXml(chap.title)}</text></navLabel><content src="${href}"/></navPoint>`);

      if (onProgress) onProgress({ phase: 'chapters', current: idx + 1, total: chaptersArr.length, title: chap.title });
      if (EPUB_CHAPTER_YIELD_EVERY > 0 && (idx + 1) % EPUB_CHAPTER_YIELD_EVERY === 0) await sleep(0);
    }

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
    zipEntries.push({ name: 'OEBPS/content.opf', data: opf });

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
    zipEntries.push({ name: 'OEBPS/toc.ncx', data: ncx });

    if (DEBUG) console.log('[ficdl] EPUB zip start', { engine: 'STORE' });

    if (onProgress) onProgress({ phase: 'zip', percent: 0, currentFile: '' });
    await sleep(0);

    // Надёжная ветка: свой ZIP без сжатия (STORE)
    const blob = await buildZipStoreBlob(zipEntries, {
      onProgress: (p) => {
        if (!onProgress) return;
        if (p.phase === 'zip_files') {
          const percent = Math.round((p.current / Math.max(1, p.total)) * 100);
          onProgress({ phase: 'zip', percent, currentFile: p.name || '' });
        } else if (p.phase === 'zip_done') {
          onProgress({ phase: 'zip', percent: 100, currentFile: '' });
        }
      }
    });

    if (DEBUG) {
      const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      console.log('[ficdl] EPUB build done', { ms: Math.round(t1 - t0), engine: 'STORE' });
    }
    return blob;
  }

  async function buildFb2(data) {
    const bookId = uuidUrn();
    const isoDate = new Date().toISOString().slice(0, 10);

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

    const keywords = [
      ...(data.fandoms || []),
      ...(data.pairings || []),
      ...(data.genres || []),
      ...(data.warnings || []),
      ...(data.otherTags || []),
      ...tagFlat,
    ]
      .map(s => String(s || '').trim())
      .filter(Boolean);
    const keywordsUniq = Array.from(new Set(keywords.map(s => s.toLowerCase())))
      .map(k => keywords.find(x => x.toLowerCase() === k) || k);

    // FB2 жанры должны быть из списка (genre), но на Ficbook это свободные строки.
    // Оставляем базовый жанр fanfiction, а дополнительные — в keywords.
    const fb2Genres = ['fanfiction'];

    let body = '';
    for (const chap of (data.chapters || [])) {
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
      ${fb2Genres.map(g => `<genre>${escapeXml(g)}</genre>`).join('\n      ')}
      <author><nickname>${escapeXml(data.author)}</nickname></author>
      <book-title>${escapeXml(data.title)}</book-title>
      ${keywordsUniq.length ? `<keywords>${escapeXml(keywordsUniq.join(', '))}</keywords>` : ''}
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
      <version>3.1</version>
    </document-info>
  </description>
  <body>
${body.trim()}
  </body>
</FictionBook>`;

    return new Blob([fb2], { type: 'text/xml;charset=utf-8' });
  }

  // ==========================================
  // 7) Функция извлечения данных из документа (для Crawler и для Saver)
  // ==========================================
  function extractChapterDataFromDoc(doc, partId, url) {
    const contentNode =
      doc.querySelector('.part_text') ||
      doc.querySelector('#content .part_text') ||
      doc.querySelector('[itemprop="articleBody"]') ||
      null;

    if (!contentNode) return null;

    const title =
      (doc.querySelector('.title-area h2')?.textContent || '').trim() ||
      (doc.querySelector('h2')?.textContent || '').trim() ||
      `Глава ${partId}`;

    const noteTopNode = doc.querySelector('.part-comment-top .urlized-links') || doc.querySelector('.part-comment-top') || null;
    const noteBotNode = doc.querySelector('.part-comment-bottom .urlized-links') || doc.querySelector('.part-comment-bottom') || null;

    return {
      id: partId,
      title,
      contentHtml: contentNode.outerHTML,
      noteTopHtml: noteTopNode ? noteTopNode.outerHTML : '',
      noteBotHtml: noteBotNode ? noteBotNode.outerHTML : '',
      savedAt: Date.now(),
      url: url
    };
  }

  // ==========================================
  // 8) Non-premium: Сохранение текущей главы при открытии
  // ==========================================
  async function collectCurrentChapterIfPossible({ silent = true } = {}) {
    if (isPremiumUser()) return false;

    const ficId = getFicIdFromUrl();
    const partId = getPartIdFromUrl();
    if (!ficId || !partId) return false;

    const data = extractChapterDataFromDoc(document, partId, location.href.split('#')[0]);
    if (!data) return false;

    const ok = await putChapter(ficId, partId, data);
    if (!silent) toast(ok ? `Сохранено: ${data.title}` : `Не удалось сохранить: ${data.title}`);
    return ok;
  }

  // ==========================================
  // 9) Non-premium: CRAWLER (Авто-обход)
  // ==========================================
  async function crawlAndCache(ficId, parts, onProgress) {
    const DEBUG = isDebugEnabled();

    // Настройки ускорения (можно тюнить в консоли):
    // localStorage.setItem('ficdl_crawl_concurrency','2')
    // localStorage.setItem('ficdl_crawl_delay_ms','800')
    // localStorage.setItem('ficdl_crawl_jitter_ms','400')
    const concurrency = Math.round(getSettingNumber('ficdl_crawl_concurrency', 1, { min: 1, max: 3 }));
    const delayMs = Math.round(getSettingNumber('ficdl_crawl_delay_ms', 1800, { min: 0, max: 15000 }));
    const jitterMs = Math.round(getSettingNumber('ficdl_crawl_jitter_ms', 1200, { min: 0, max: 15000 }));
    const retries = Math.round(getSettingNumber('ficdl_crawl_retries', 2, { min: 0, max: 5 }));
    const backoff429Base = Math.round(getSettingNumber('ficdl_crawl_backoff429_ms', 15000, { min: 1000, max: 120000 }));

    let done = 0;
    const total = parts.length;
    let next = 0;

    const doOne = async (p, idx) => {
      // 1) кэш
      const existing = await getChapter(ficId, p.partId);
      if (existing && existing.contentHtml) return 'cached';

      // 2) fetch + parse + save
      let attempt = 0;
      while (true) {
        try {
          const resp = await fetch(p.url, { credentials: 'same-origin' });
          if (!resp.ok) {
            if (resp.status === 429) {
              const ra = resp.headers?.get?.('Retry-After');
              const raMs = ra ? (Number(ra) * 1000) : NaN;
              const waitMs = Number.isFinite(raMs) ? raMs : (backoff429Base + Math.random() * 5000);
              if (DEBUG) console.warn('[ficdl] 429 rate limited', { partId: p.partId, waitMs: Math.round(waitMs) });
              await sleep(waitMs);
              throw new Error('HTTP 429');
            }
            throw new Error(`HTTP ${resp.status}`);
          }

          const text = await resp.text();
          const doc = new DOMParser().parseFromString(text, 'text/html');
          const data = extractChapterDataFromDoc(doc, p.partId, p.url);
          if (data) await putChapter(ficId, p.partId, data);
          else console.error(`Не удалось распарсить главу ${p.title}`);
          return 'fetched';
        } catch (e) {
          if (attempt++ >= retries) {
            console.error(`Ошибка при скачивании ${p.title}:`, e);
            return 'error';
          }
          if (DEBUG) console.warn('[ficdl] retry chapter', { partId: p.partId, attempt, error: String(e?.message || e) });
          await sleep(500 + Math.random() * 500);
        }
      }
    };

    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= parts.length) break;
        const p = parts[i];

        if (onProgress) onProgress(i + 1, total, 'fetching');
        const res = await doOne(p, i);
        done++;
        if (onProgress) onProgress(done, total, res);

        // небольшой rate-limit между задачами в воркере (уменьшает риск блокировок)
        const pause = delayMs + (jitterMs ? Math.random() * jitterMs : 0);
        if (pause > 0) await sleep(pause);
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, parts.length) }, () => worker());
    await Promise.all(workers);
  }

  // ==========================================
  // 10) Сборка книги из кэша
  // ==========================================
  async function buildFromCacheWithAutoCrawl({ onProgress }) {
    const ficId = getFicIdFromUrl();
    if (!ficId) throw new Error('Не удалось определить ID фанфика.');

    // Получаем оглавление
    const tocDoc = await fetchTocDoc();
    const meta = parseMeta(tocDoc);
    const parts = parseTocParts(tocDoc);

    if (!parts.length) throw new Error('Не найден список глав (list-of-fanfic-parts).');

    // ЗАПУСК КРОУЛЕРА
    await crawlAndCache(ficId, parts, (curr, total, type) => {
        const status = type === 'cached' ? 'Кэш' : 'Загрузка';
        if (onProgress) onProgress(`${curr}/${total} ${status}`);
    });

    // Собираем chapters из кэша
    const chapters = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const rec = await getChapter(ficId, p.partId);

      // Если главы нет даже после кроулера — заглушка
      let contentNode, noteTopNode, noteBotNode;

      if (rec && rec.contentHtml) {
          contentNode = elementFromHtml(rec.contentHtml);
          noteTopNode = rec.noteTopHtml ? elementFromHtml(rec.noteTopHtml) : null;
          noteBotNode = rec.noteBotHtml ? elementFromHtml(rec.noteBotHtml) : null;
      } else {
          contentNode = document.createElement('div');
          contentNode.innerHTML = `<p>[Ошибка: Глава не была скачана]</p>`;
      }

      chapters.push({
        title: rec?.title || p.title,
        noteTopNode,
        contentNode,
        noteBottomNode: noteBotNode,
      });
    }

    return { ...meta, chapters, url: getBaseFicUrl() };
  }

  // ==========================================
  // 11) UI
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

  function createBtn(label, onClick, extraClass = 'btn-success') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn btn-with-description ${extraClass} kaiho-ficdl-btn`;
    btn.dataset.kaihoFicdl = '1';
    btn.innerHTML = `<span class="main-info">${label}</span><span class="description">Скачать</span>`;
    btn.addEventListener('click', onClick, { passive: false });
    return btn;
  }

  function setBtnText(btn, main, desc) {
    btn.innerHTML = `<span class="main-info">${escapeXml(main)}</span><span class="description">${escapeXml(desc)}</span>`;
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function handleDownload(format, btn) {
    const original = btn.innerHTML;
    btn.disabled = true;
    setBtnText(btn, '...', 'Подготовка');

    try {
      const setBuildProgress = (p) => {
        if (!p) return;
        if (p.phase === 'chapters') {
          setBtnText(btn, `Сборка ${p.current}/${p.total}`, 'EPUB');
          return;
        }
        if (p.phase === 'zip') {
          const percent = Math.max(0, Math.min(100, Math.round(p.percent || 0)));
          setBtnText(btn, `Упаковка ${percent}%`, 'EPUB');
        }
      };

      let data = null;
      const ext = format;

      if (isPremiumUser()) {
        if (!isProbablyAllParts(document)) {
          if (confirm("Для Premium быстрее открыть «Все части одной лентой» (all-parts). Перейти?")) {
            goToAllParts();
          }
          return;
        }
        data = parseStoryAllParts(document);
        if (!data?.chapters?.length) throw new Error('Не удалось найти главы на all-parts.');
      } else {
        // NON-PREMIUM: Auto-Crawl + Cache
        data = await buildFromCacheWithAutoCrawl({
          onProgress: (statusText) => setBtnText(btn, statusText, 'Главы...')
        });
      }

      if (!data) return;

      setBtnText(btn, 'Сборка', format.toUpperCase());
      await sleep(50);

      const blob = (format === 'epub')
        ? await buildEpub(data, { onProgress: setBuildProgress })
        : await buildFb2(data);

      triggerDownload(blob, `${safeFilename(data.title)} - ${safeFilename(data.author)}.${ext}`);
      setBtnText(btn, 'OK', 'Готово');
    } catch (e) {
      console.error(e);
      alert('Ошибка: ' + (e?.message || e));
      setBtnText(btn, 'Err', 'Ошибка');
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = original;
      }, 1500);
    }
  }

  async function updateProgressLabels(btnEpub, btnFb2) {
    if (isPremiumUser()) return;
    const ficId = getFicIdFromUrl();
    if (!ficId) return;

    let parts = [];
    try {
      const tocDoc = await fetchTocDoc();
      parts = parseTocParts(tocDoc);
    } catch (_) {
      return;
    }
    if (!parts.length) return;

    let have = 0;
    for (const p of parts) {
      const rec = await getChapter(ficId, p.partId);
      if (rec?.contentHtml) have++;
    }
    const total = parts.length;

    const t1 = btnEpub.querySelector('.main-info');
    const t2 = btnFb2.querySelector('.main-info');
    if (t1) t1.textContent = `EPUB`;
    if (t2) t2.textContent = `FB2`;
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

    // reset cache button
    const ficId = getFicIdFromUrl();
    if (ficId && !isPremiumUser()) {
      const btnClear = createBtn('Сброс', async (e) => {
        e.preventDefault();
        if (confirm('Удалить сохранённые главы из кэша для этого фанфика?')) {
          await clearFicCache(ficId);
          toast('Кэш очищен');
          location.reload();
        }
      }, 'btn-default');
      btnClear.querySelector('.description').textContent = 'Кэш';
      btnContainer.appendChild(btnClear);
    }

    // progress labels
    updateProgressLabels(btnEpub, btnFb2).catch(() => {});
    return true;
  }

  // ==========================================
  // 12) Init
  // ==========================================
  function pageUrlKey() {
    return location.href.split('#')[0];
  }

  let _lastInitUrl = null;
  let _lastCollectUrl = null;
  let _initTimer = null;

  function init() {
    injectButtons();

    // non-premium: сохраняем главу при открытии (1 раз на URL за жизненный цикл страницы)
    const u = pageUrlKey();
    if (!isPremiumUser() && _lastCollectUrl !== u) {
      _lastCollectUrl = u;
      collectCurrentChapterIfPossible({ silent: true }).then((ok) => {
        if (ok && !sessionStorage.getItem('ficdl_saved_once:' + u)) {
          sessionStorage.setItem('ficdl_saved_once:' + u, '1');
          toast('Глава сохранена в кэш');
        }
      }).catch(() => {});
    }

    _lastInitUrl = u;
  }

  function scheduleInit() {
    if (_initTimer) return;
    _initTimer = setTimeout(() => {
      _initTimer = null;
      // Даже если DOM меняется часто, достаточно периодически пытаться вставить кнопки.
      // Кроме того, Ficbook может менять URL через History API без перезагрузки.
      const u = pageUrlKey();
      if (u !== _lastInitUrl) _lastCollectUrl = null;
      init();
    }, 200);
  }

  init();

  const obs = new MutationObserver(() => scheduleInit());
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
