// solve.js — a fast drop-in for makefun-site 1.0.0, written from scratch for
// site-generator-speed-01 (build a static site faster, 22 November 2026).
//
// It returns exactly makefun-site 1.0.0's answer for every input: the output
// tree (each page's index.html, the index and tag pages, build-report.txt and
// each static file) as a JSON object of path -> text, byte for byte.
//
// Same rules, different engine: the front matter, template dialect, Markdown
// subset, slug rule and report are makefun-site's own (see the kit's
// vendor/makefun-site/README.md), and this file reimplements them with
// single-pass scans, range-based inline rendering and an output buffer instead
// of per-character escaping, per-line regexes and string concatenation.
//
// No network, no clock, no environment, no randomness: the answer is a pure
// function of the input. Nothing is cached from one case to the next; the
// slug cache lives inside one run() call only.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const RESERVED = ['posts', 'tags', 'page'];

// ------------------------------------------------------------------ text

const ESC1 = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
/** `text` with & < > " and ' escaped. */
function escapeHtml(s) {
  return s.replace(ESC_RE, (c) => ESC1[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const NON_ASCII = /[^\x00-\x7F]/;
const MARK_RE = /\p{M}/gu;
/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 *  of characters other than a-z and 0-9 one "-", none at either end, at most 64
 *  characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 *  ASCII text is already NFKD-normalised and holds no combining marks, so it
 *  takes the fast path; anything else goes through normalise + mark strip. */
function slugify(text) {
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(MARK_RE, '') : text;
  let out = '';
  let gap = false;
  if (plain === text) {
    for (let i = 0; i < plain.length; i++) {
      const ch = plain[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  } else {
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out;
  do {
    out = `${slug}-${n++}`;
  } while (taken.has(out));
  taken.add(out);
  return out;
}

/** A slug, cached inside this build (slugify is pure, so the cache is exact). */
function slugOf(B, text) {
  const hit = B.slugCache.get(text);
  if (hit !== undefined) return hit;
  const s = slugify(text);
  B.slugCache.set(text, s);
  return s;
}

// ------------------------------------------------------------------ whitespace

/** Whether a code unit is a JS \s whitespace character. */
function isWSCode(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** Whether `line` holds only spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs dropped at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether the slice src[a..b) holds only spaces and tabs. */
function isSpaces(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ------------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUGV_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUGV_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing "---" line.
  let closeStart = -1;
  let closeEnd = -1;
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const lineEnd = e === -1 ? text.length : e;
    if (text.slice(pos, lineEnd) === '---') {
      closeStart = pos;
      closeEnd = lineEnd;
      break;
    }
    if (e === -1) break;
    pos = e + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 1; // the opening "---" is line 1
  let p = firstNl === -1 ? text.length : firstNl + 1;
  while (p < closeStart) {
    const e = text.indexOf('\n', p);
    const lineEnd = e === -1 ? text.length : e;
    const line = text.slice(p, lineEnd);
    lineNo++;
    if (!isBlank(line) && line.charCodeAt(0) !== 35) {
      // "key: value": a key of a-z and _, a colon, one space and the value.
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) {
        return { error: `line ${lineNo} is not "key: value"` };
      }
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) {
        raw = line.slice(k + 2);
        let r = raw.length;
        while (r > 0 && (raw.charCodeAt(r - 1) === 32 || raw.charCodeAt(r - 1) === 9)) r--;
        raw = raw.slice(0, r);
      } else {
        return { error: `line ${lineNo} is not "key: value"` };
      }
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (e === -1) break;
    p = e + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

// ------------------------------------------------------------------ Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (
      (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
      c === 95 || c === 43 || c === 45
    ) i++;
    else break;
  }
  const langEnd = i;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  if (i !== line.length) return null;
  return line.slice(3, langEnd);
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text span, or null (a heading's text is never empty). */
function headingOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 35) i++;
  if (i === 0 || i > 6 || i >= line.length) return null;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  let j = i;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let end = line.length;
  while (end > j && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === j) return null;
  return { depth: i, start: j, end };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (line.length < 3) return false;
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const cc = line.charCodeAt(i);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/** A bullet item's content, or null. */
function bulletContent(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and content, or null. */
function orderedItem(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), content: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j >= line.length) return false;
  return !isWSCode(line.charCodeAt(j));
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `target` holds a URI scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (
      !((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 43 || c === 45 || c === 46)
    ) return false;
  }
  return false;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A link target's href: kept as written, resolved to a page or static file, or reported broken. */
function linkTarget(B, dir, target, srcPath) {
  if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(dir, rel);
  if (path !== null) {
    const pg = B.bySource.get(path);
    if (pg !== undefined) return `${pg.url}${frag}`;
    if (B.staticPaths.has(path)) return `${B.base}/${path}${frag}`;
  }
  B.broken.add(`broken-link ${srcPath} -> ${target}`);
  return target;
}

/**
 * `s[a..b)` rendered inline, appended to `out`: code spans, strong, emphasis,
 * links and backslash escapes, left to right. Plain runs (no syntax character
 * and no HTML special) are appended whole; only the characters that need it
 * are escaped one by one.
 */
function inlineRange(B, s, a, b, dir, srcPath, out) {
  let i = a;
  while (i < b) {
    let j = i;
    while (j < b) {
      const c = s.charCodeAt(j);
      if (
        c === 92 || c === 96 || c === 42 || c === 91 ||
        c === 38 || c === 60 || c === 62 || c === 34 || c === 39
      ) break;
      j++;
    }
    if (j > i) {
      out.push(s.slice(i, j));
      i = j;
    }
    if (i >= b) break;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < b && ESCAPABLE.has(s[i + 1])) {
        const n = s[i + 1];
        out.push(ESC1[n] ?? n);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < b && k > i + 1) {
        out.push(`<code>${escapeHtml(s.slice(i + 1, k))}</code>`);
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const k = findUnescaped(s, '**', i + 2, b);
        if (k > i + 2) {
          out.push('<strong>');
          inlineRange(B, s, i + 2, k, dir, srcPath, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
      } else {
        const k = findSingleStar(s, i + 1, b);
        if (k > i + 1) {
          out.push('<em>');
          inlineRange(B, s, i + 1, k, dir, srcPath, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i++;
        }
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, b);
      let m = -1;
      if (k !== -1 && s.charCodeAt(k + 1) === 40) m = s.indexOf(')', k + 2);
      let target = '';
      if (m !== -1 && m < b) target = s.slice(k + 2, m);
      else m = -1;
      if (m !== -1 && target !== '' && !WS_RE.test(target)) {
        out.push(`<a href="${escapeHtml(linkTarget(B, dir, target, srcPath))}">`);
        inlineRange(B, s, i + 1, k, dir, srcPath, out);
        out.push('</a>');
        i = m + 1;
      } else {
        out.push('[');
        i++;
      }
      continue;
    }
    out.push(ESC1[s[i]]);
    i++;
  }
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(B, src, dir, srcPath) {
  const lines = src.split('\n');
  const n = lines.length;
  const parts = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      parts.push(`<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>`);
      for (const l of body) {
        parts.push(escapeHtml(l));
        parts.push('\n');
      }
      parts.push('</code></pre>\n');
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugOf(B, line.slice(hd.start, hd.end)), ids);
      const t2 = [];
      inlineRange(B, line, hd.start, hd.end, dir, srcPath, t2);
      const html = t2.join('');
      parts.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      parts.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(/^> ?/, ''));
      const inner = body.map(trimLine).filter((l) => l !== '');
      if (inner.length === 0) {
        parts.push('<blockquote>\n</blockquote>\n');
      } else {
        const joined = inner.join('\n');
        const t2 = [];
        inlineRange(B, joined, 0, joined.length, dir, srcPath, t2);
        parts.push(`<blockquote>\n<p>${t2.join('')}</p>\n</blockquote>\n`);
      }
      continue;
    }
    const bullet = bulletContent(line);
    const ordered = bullet === null ? orderedItem(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [[trimLine(isOrdered ? ordered.content : bullet)]];
      const start = isOrdered ? ordered.num : 1;
      i++;
      while (i < n) {
        let content = null;
        if (isOrdered) {
          const o = orderedItem(lines[i]);
          if (o !== null) content = o.content;
        } else {
          content = bulletContent(lines[i]);
        }
        if (content !== null) {
          items.push([trimLine(content)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      parts.push(`${open}\n`);
      for (const item of items) {
        const text = item.join('\n');
        const t2 = [];
        inlineRange(B, text, 0, text.length, dir, srcPath, t2);
        parts.push(`<li>${t2.join('')}</li>\n`);
      }
      parts.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const t2 = [];
    inlineRange(B, text, 0, text.length, dir, srcPath, t2);
    const html = t2.join('');
    if (excerpt === null) excerpt = html;
    parts.push(`<p>${html}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s` holds any whitespace. */
function hasWS(s) {
  for (let i = 0; i < s.length; i++) if (isWSCode(s.charCodeAt(i))) return true;
  return false;
}

function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}
function isNameChar(c) {
  return isNameStart(c) || (c >= 48 && c <= 57);
}

/** `tag` as a for tag, or null: "for <name> in <path>". */
function parseForTag(name, tag) {
  if (!tag.startsWith('for ')) return null;
  let i = 4;
  if (i >= tag.length || !isNameStart(tag.charCodeAt(i))) return null;
  const start = i;
  i++;
  while (i < tag.length && isNameChar(tag.charCodeAt(i))) i++;
  const varName = tag.slice(start, i);
  if (tag.slice(i, i + 4) !== ' in ') return null;
  const p = tag.slice(i + 4);
  if (p === '' || hasWS(p)) return null;
  return { name: varName, path: pathOf(name, p) };
}

/** `tag` as an if tag, or null: "if [not ]<path>". */
function parseIfTag(name, tag) {
  if (!tag.startsWith('if ')) return null;
  let i = 3;
  let not = false;
  if (tag.startsWith('not ', i)) {
    not = true;
    i += 4;
  }
  const p = tag.slice(i);
  if (p === '' || hasWS(p)) return null;
  return { not, path: pathOf(name, p) };
}

/** `tag` as an include tag's name, or null: 'include "<name>"'. */
function parseIncludeTag(tag) {
  if (tag.length < 12 || !tag.startsWith('include "') || tag.charCodeAt(tag.length - 1) !== 34) return null;
  const inner = tag.slice(9, -1);
  if (inner === '') return null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return inner;
}

// Node kinds: 0 text [0, str]; 1 var [1, path, raw]; 2 if [2, not, path, then, else|null];
// 3 for [3, name, path, body]; 4 include [4, name].

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 0, text });
      text = '';
      tokens.push({ t: raw ? 2 : 1, path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone = isSpaces(src, lineStart, open) && isSpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 0, text });
    text = '';
    tokens.push({ t: 3, tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 0, text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = [];
  const stack = [{ node: null, body: root }];
  let body = root;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 0) body.push([0, tok.text]);
    else if (tok.t === 1 || tok.t === 2) body.push([1, tok.path, tok.t === 2]);
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = parseForTag(name, tag)) !== null) {
        const node = [3, m.name, m.path, []];
        body.push(node);
        stack.push({ node, body: node[3] });
        body = node[3];
      } else if ((m = parseIfTag(name, tag)) !== null) {
        const node = [2, m.not, m.path, [], null];
        body.push(node);
        stack.push({ node, body: node[3] });
        body = node[3];
      } else if (tag === 'else') {
        if (top.node === null || top.node[0] !== 2 || top.node[4] !== null) {
          throw new TemplateError(`template "${name}": an else outside an if`);
        }
        top.node[4] = [];
        top.body = top.node[4];
        body = top.node[4];
      } else if (tag === 'endfor' || tag === 'endif') {
        const want = tag === 'endfor' ? 3 : 2;
        if (top.node === null || top.node[0] !== want) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        body = stack[stack.length - 1].body;
      } else if ((m = parseIncludeTag(tag)) !== null) {
        body.push([4, m]);
      } else {
        throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 1) {
    const kind = stack[stack.length - 1].node[0] === 3 ? 'for' : 'if';
    throw new TemplateError(`template "${name}": a ${kind} is not closed`);
  }
  return root;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }), appended to `out`. */
function renderNodes(B, nodes, scope, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    const k = node[0];
    if (k === 0) {
      out.push(node[1]);
    } else if (k === 1) {
      const v = lookup(scope, node[1]);
      // textOf, with the common string/number cases inlined.
      let s;
      if (typeof v === 'string') s = v;
      else if (typeof v === 'number') s = String(v);
      else if (typeof v === 'boolean') s = v ? 'true' : 'false';
      else s = textOf(v);
      out.push(node[2] ? s : escapeHtml(s));
    } else if (k === 2) {
      const v = truthy(lookup(scope, node[2]));
      const branch = v !== node[1] ? node[3] : node[4];
      if (branch !== null) renderNodes(B, branch, scope, depth, out);
    } else if (k === 3) {
      const xs = lookup(scope, node[2]);
      if (Array.isArray(xs)) {
        const len = xs.length;
        for (let j = 0; j < len; j++) {
          const vars = {
            [node[1]]: xs[j],
            loop: { index: j + 1, first: j === 0, last: j === len - 1, length: len },
          };
          renderNodes(B, node[3], { vars, parent: scope }, depth, out);
        }
      }
    } else if (k === 4) {
      const t = B.templates.get(node[1]);
      if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(B, t, scope, depth + 1, out);
    }
  }
}

// ------------------------------------------------------------------ the build

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // JS \s, inlined: space, \t \n \v \f \r, and the Unicode spaces.
    const ws =
      c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
      c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
      c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(B) {
  const files = [...B.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      B.sources.push({
        path: f.path,
        text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n'),
      });
    } else B.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(B) {
  const kept = [];
  for (const s of B.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      B.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      B.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      B.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!B.templates.has(layout)) {
      B.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      B.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  B.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(B) {
  const taken = new Map();
  const takenIn = (dir) => {
    let s = taken.get(dir);
    if (s === undefined) {
      s = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, s);
    }
    return s;
  };
  for (const s of B.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugOf(B, s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${B.base}/${s.outDir}/`;
    B.bySource.set(s.path, s);
  }
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(B) {
  const staticPaths = new Set();
  for (const f of B.statics) staticPaths.add(f.path);
  B.staticPaths = staticPaths;
  for (const s of B.sources) {
    const md = renderMarkdown(B, s.body, dirOf(s.path), s.path);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(B) {
  const posts = B.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  B.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

/** A source's tags, each slug once, in its own order (the first spelling kept). */
function ownTags(B, s) {
  const seen = new Set();
  const out = [];
  for (const name of s.data.tags ?? []) {
    const slug = slugOf(B, name);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(name);
  }
  return out;
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(B) {
  const bySlug = new Map();
  for (const p of B.posts) {
    p.tagRefs = [];
    for (const name of ownTags(B, p)) {
      const slug = slugOf(B, name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${B.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of B.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(B, s).map((name) => {
        const slug = slugOf(B, name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  B.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null
    ? null
    : {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      };

/** A post's card, as lists show it. */
function cardOf(B, s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(B, s) {
  const card = s.post ? B.cards.get(s) : cardOf(B, s);
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** A tag as templates read it (its posts as cards). */
const tagOf = (B, t) => ({
  name: t.name,
  slug: t.slug,
  url: t.url,
  count: t.posts.length,
  posts: t.posts.map((p) => B.cards.get(p)),
});

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(B) {
  B.cards = new Map();
  for (const p of B.posts) B.cards.set(p, cardOf(B, p));
  const site = { title: B.input.site.title, base_url: B.base };
  const allTags = B.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = B.posts.slice(0, B.input.site.recent).map((p) => B.cards.get(p));
  // One root frame per build; each render adds its own frame on top. The two
  // name sets are disjoint (site/tags/recent vs page/posts/pager/tag), so a
  // lookup resolves exactly as it would in one merged object, innermost first.
  const rootScope = { vars: { site, tags: allTags, recent }, parent: null };
  const render = (name, vars) => {
    const nodes = B.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(B, nodes, { vars, parent: rootScope }, 0, out);
    return out.join('');
  };
  for (const s of B.sources) B.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(B, s) });
  const per = B.input.site.per_page;
  const pages = Math.max(1, Math.ceil(B.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${B.base}/` : `${B.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: B.posts.slice((k - 1) * per, k * per).map((p) => B.cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) B.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of B.tags) {
    const html = render('tag', { tag: tagOf(B, t) });
    if (html !== null) B.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) B.output['tags/index.html'] = tagsHtml;
  for (const f of B.statics) {
    if (Object.hasOwn(B.output, f.path)) B.report.push(`shadowed ${f.path}: a built page has its path`);
    else B.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function reportStep(B) {
  const lines = [...B.report, ...B.broken].sort(byCodeUnits);
  let pages = 0;
  for (const s of B.sources) if (!s.post) pages++;
  lines.push(`built ${pages} pages, ${B.posts.length} posts, ${B.tags.length} tags and ${B.statics.length} static files`);
  B.output['build-report.txt'] = `${lines.join('\n')}\n`;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const B = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
    slugCache: new Map(),
    staticPaths: new Set(),
  };
  readSources(B);
  frontMatter(B);
  permalinks(B);
  markdown(B);
  collections(B);
  tags(B);
  layouts(B);
  reportStep(B);
  return B.output;
}
