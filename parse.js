// Faster drop-in for marked 18.1.3 (default options: GFM on, breaks off).
// Written from scratch for the markdown-render-speed-02 competition: a
// CommonMark 0.31.2 + GFM 0.29 parser whose parse(markdown) returns exactly
// the HTML marked 18.1.3 renders. Dependency-free ES module.
//
// Design: two phases like any CommonMark parser. Phase one lexes blocks
// (headings, code, quotes, lists, tables, HTML, link definitions,
// paragraphs) into a small token tree and collects link reference
// definitions, so a definition anywhere in the document applies to links
// anywhere. Phase two parses inline content per block (escapes, code
// spans, emphasis/strong/del via a delimiter stack, links, images,
// autolinks, entities, hard breaks) and renders straight to a string.

const NAMED_ENTITIES = null; // named entities pass through untouched (marked does not decode them)

const RE_NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const RE_NUM_REF_OR_STRAY_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RE_ESC_TEST = /[&<>"']/;
const RE_ESC_REPLACE = /[&<>"']/g;
const RE_ESC_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const RE_ESC_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RE_PUNCT = /[\p{P}\p{S}]/u;
const RE_PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const RE_NON_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const RE_ALPHA_NUM = /[\p{L}\p{N}]/u;
const RE_OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape HTML special chars. encode=true escapes every &; encode=false
// leaves & alone when it starts a valid entity reference.
export function escapeHtml(s, encode) {
  if (encode) {
    if (!RE_ESC_TEST.test(s)) return s;
    return s.replace(RE_ESC_REPLACE, (c) => ESCAPES[c]);
  }
  if (!RE_ESC_TEST_NO_ENCODE.test(s)) return s;
  return s.replace(RE_ESC_REPLACE_NO_ENCODE, (c) => ESCAPES[c]);
}

// Decode numeric character references in inline text the way marked does:
// &#0;, > U+10FFFF or a surrogate become U+FFFD; &#38; becomes &amp;;
// a bare & not starting a valid reference becomes &amp;. Named references
// and valid numeric ones pass through unchanged.
function decodeEntities(s) {
  if (!RE_NUM_REF.test(s)) return s;
  return s.replace(RE_NUM_REF_OR_STRAY_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// Percent-encode a link destination the way marked does (encodeURI, then
// restore literal % that encodeURI itself produced from %25).
function encodeHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Normalize a link label: trim, collapse internal whitespace to one space,
// case-fold (lower then upper then lower, as marked does).
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Remove a backslash before an ASCII punctuation character.
function unescapeBackslash(s) {
  return s.replace(/\\([\p{P}\p{S}])/gu, '$1');
}

// Expand tabs to spaces up to the next multiple of 4, starting at column col.
function expandTabs(line, col) {
  let out = '';
  let c = col;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\t') {
      const n = 4 - (c % 4);
      out += ' '.repeat(n);
      c += n;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// Count leading spaces, expanding a leading tab to the next tab stop.
function indentOf(line) {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4 - (n % 4);
    else break;
  }
  return n;
}

// A line is blank when it holds only spaces/tabs.
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

// Strip up to `n` columns of indentation from the start of a line
// (a tab counts to the next tab stop).
function stripIndent(line, n) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') {
      const next = col + (4 - (col % 4));
      if (next > n) return ' '.repeat(next - n) + line.slice(i + 1);
      col = next; i++;
    } else break;
  }
  return line.slice(i);
}

// ---------------------------------------------------------------------------
// Block lexer
// ---------------------------------------------------------------------------

const RE_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const RE_INDENTED_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const RE_CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const RE_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const RE_ATX = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const RE_HR = /^ {0,3}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const RE_HTML_BLOCK_TAG = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const RE_HTML_BLOCK = new RegExp(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' +
  '|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)' +
  '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' +
  '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' +
  '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' +
  '|</?(?:' + RE_HTML_BLOCK_TAG + ')(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' +
  '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' +
  '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i');
const RE_HTML_BEGIN = new RegExp(
  '^ {0,3}(?:</?(?:' + RE_HTML_BLOCK_TAG + ')(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i');
const RE_LABEL_INNER = /(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const RE_DEF = new RegExp(
  '^ {0,3}\\[(?!\\s*\\])(' + RE_LABEL_INNER.source + ')\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)' +
  '(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(' + '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\)' + '))? *(?:\\n+|$)');
// Shared fragments for the composite block regexes (paragraph, setext,
// table): the same "a line that would start another block" tests.
const FRAG = {
  hr: ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)',
  heading: ' {0,3}#{1,6}(?:\\s|$)',
  bq: ' {0,3}>',
  fencesLine: ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
  listPara: ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]',
  listTable: ' {0,3}(?:[*+-]|1[.)])[ \\t]',
  htmlBegin: ' {0,3}(?:</?(?:' + RE_HTML_BLOCK_TAG + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
  tableLine: ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n',
  // A table start, as marked's paragraph lookahead tests it: this line
  // as the header AND the next line as the delimiter row. A lone
  // delimiter-looking line does NOT interrupt a paragraph.
  tableStart: ' *[^\\n ].*\\n {0,3}(?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?',
  codeLine: '(?: {4}| {0,3}\\t)[^\\n]',
};
const RE_TABLE = new RegExp(
  '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)' +
  '(?:\\n((?:(?! *\\n|' + FRAG.hr + '|' + FRAG.heading + '|' + FRAG.bq + '|' + FRAG.codeLine + '|' + FRAG.fencesLine + '|' + FRAG.listTable + '|' + FRAG.htmlBegin + ').*(?:\\n|$))*)|\\n*|$)');
const RE_TABLE_DELIM = /[:|]/;
const RE_TABLE_ALIGN_TRIM = /^\||\| *$/g;
const RE_SETEXT = /^((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const RE_BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const RE_PARA = new RegExp(
  '^([^\\n]+(?:\\n(?!' + FRAG.hr + '|' + FRAG.heading + '|' + FRAG.bq + '|' + FRAG.fencesLine + '|' + FRAG.listPara + '|' + FRAG.htmlBegin + '|' + FRAG.tableStart + '|[ \\t]+\\n)[^\\n]+)*)');
const RE_TEXT_LINE = /^[^\n]+/;
const RE_BLANK = /^[ \t]*$/;
const RE_DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;

// Split a table row on unescaped pipes, honouring the header's cell count.
function splitTableRow(row, count) {
  let s = row.replace(/\|/g, (ch, off, str) => {
    let backslashes = 0;
    for (let p = off - 1; p >= 0 && str[p] === '\\'; p--) backslashes++;
    return backslashes % 2 === 1 ? '|' : ' |';
  });
  const cells = s.split(' |');
  let i = 0;
  if (cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Remove trailing blank lines, keeping at most one trailing newline's worth:
// if more than one blank line trails, drop them all.
function trimTrailingBlanks(text) {
  const lines = text.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && RE_BLANK.test(lines[t])) t--;
  if (lines.length - t <= 2) return text;
  return lines.slice(0, t + 1).join('\n');
}

class BlockLexer {
  constructor() {
    this.links = Object.create(null);
    this.inlineQueue = [];
    this.state = { top: true };
  }

  // Lex a whole document string into block tokens (inline tokens filled in
  // afterwards, once every link definition has been seen).
  lexDocument(src) {
    src = src.replace(/\r\n|\r/g, '\n');
    const tokens = this.lexBlocks(src, true);
    for (const q of this.inlineQueue) {
      q.tokens.push(...parseInline(q.src, this));
    }
    this.inlineQueue = [];
    return tokens;
  }

  // Queue inline parsing for a token's text (done after the whole document
  // is block-lexed so forward link references resolve).
  queueInline(token, src) {
    token.tokens = [];
    this.inlineQueue.push({ src, tokens: token.tokens });
  }

  // Lex blocks from `src`, appending tokens to `into`. `top` marks the
  // document level (paragraphs may start there without interruption
  // checks); `inBlockquote` merges a paragraph with the previous one,
  // which is how lazy continuation lines join the paragraph above them.
  lexBlocks(src, top, into = [], inBlockquote = false) {
    const tokens = into;
    let prevLen = Infinity;
    while (src) {
      if (src.length >= prevLen) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      prevLen = src.length;
      let tok;
      if ((tok = this.trySpace(src))) { src = src.slice(tok.raw.length); this.mergeSpace(tokens, tok); continue; }
      if ((tok = this.tryCode(src))) { src = src.slice(tok.raw.length); this.mergeCode(tokens, tok); continue; }
      if ((tok = this.tryFences(src))) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tryHeading(src))) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tryHr(src))) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tryBlockquote(src))) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tryList(src))) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tryHtml(src))) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tryDef(src))) { src = src.slice(tok.raw.length); this.mergeDef(tokens, tok); continue; }
      if ((tok = this.tryTable(src))) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.trySetext(src))) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
      // Paragraph: the regex itself encodes which lines may continue it.
      // A paragraph only forms at the top level of a block container; in
      // a list item (top=false) the same lines become a text token, which
      // the list turns into a paragraph only when the list is loose.
      if (top && (tok = this.tryParagraph(src))) {
        const last = tokens[tokens.length - 1];
        if (inBlockquote && last && last.type === 'paragraph') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else {
          tokens.push(tok);
        }
        src = src.slice(tok.raw.length);
        continue;
      }
      if ((tok = this.tryText(src))) {
        const last = tokens[tokens.length - 1];
        if (last && last.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else {
          tokens.push(tok);
        }
        src = src.slice(tok.raw.length);
        continue;
      }
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }

  mergeSpace(tokens, tok) {
    const last = tokens[tokens.length - 1];
    if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
    else tokens.push(tok);
  }

  mergeCode(tokens, tok) {
    const last = tokens[tokens.length - 1];
    if (last && (last.type === 'paragraph' || last.type === 'text')) {
      last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
      last.text += '\n' + tok.text;
      this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
    } else tokens.push(tok);
  }

  mergeDef(tokens, tok) {
    const last = tokens[tokens.length - 1];
    if (last && (last.type === 'paragraph' || last.type === 'text')) {
      last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
      last.text += '\n' + tok.raw;
      this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
    } else {
      if (!this.links[tok.tag]) this.links[tok.tag] = { href: tok.href, title: tok.title };
      tokens.push(tok);
    }
  }

  trySpace(src) {
    const m = RE_NEWLINE.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
    return null;
  }

  tryCode(src) {
    const m = RE_INDENTED_CODE.exec(src);
    if (!m) return null;
    const raw = trimTrailingBlanks(m[0]);
    const text = raw.replace(RE_CODE_REMOVE_INDENT, '');
    return { type: 'code', raw, text, codeBlockStyle: 'indented' };
  }

  tryFences(src) {
    const m = RE_FENCES.exec(src);
    if (!m) return null;
    const raw = m[0];
    let text = m[3] || '';
    // Indent compensation: lines lose up to the opening fence's indent.
    const indentMatch = /^(\s+)(?:```)/.exec(raw);
    if (indentMatch) {
      const ind = indentMatch[1];
      text = text.split('\n').map((line) => {
        const lead = /^ +/.exec(line);
        if (!lead) return line;
        return line.slice(Math.min(lead[0].length, ind.length));
      }).join('\n');
    }
    const info = m[2] ? m[2].trim().replace(/\\([\p{P}\p{S}])/gu, '$1') : m[2];
    return { type: 'code', raw, lang: info, text };
  }

  tryHeading(src) {
    const m = RE_ATX.exec(src);
    if (!m) return null;
    let text = m[2].trim();
    if (/#$/.test(text)) {
      const stripped = text.replace(/#+$/, '');
      if (!stripped || /[ \t]$/.test(stripped)) text = stripped.trim();
    }
    const raw = m[0].replace(/\n$/, '');
    const tok = { type: 'heading', raw, depth: m[1].length, text };
    this.queueInline(tok, text);
    return tok;
  }

  tryHr(src) {
    const m = RE_HR.exec(src);
    if (!m) return null;
    return { type: 'hr', raw: m[0].replace(/\n$/, '') };
  }

  tryHtml(src) {
    const m = RE_HTML_BLOCK.exec(src);
    if (!m) return null;
    const raw = trimTrailingBlanks(m[0]);
    return { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
  }

  tryDef(src) {
    const m = RE_DEF.exec(src);
    if (!m) return null;
    const label = m[1];
    let href = m[2];
    if (!href.startsWith('<') && parenBalance(href) !== -1) return null;
    if (href.startsWith('<')) href = href.slice(1, -1);
    href = unescapeBackslash(href);
    const title = m[3] ? unescapeBackslash(m[3].slice(1, -1)) : m[3];
    const raw = m[0].replace(/\n$/, '');
    return { type: 'def', tag: normalizeLabel(label), raw, href, title };
  }

  tryTable(src) {
    const m = RE_TABLE.exec(src);
    if (!m || !RE_TABLE_DELIM.test(m[2])) return null;
    const headerCells = splitTableRow(m[1]);
    const aligns = m[2].replace(RE_TABLE_ALIGN_TRIM, '').split('|');
    if (headerCells.length !== aligns.length) return null;
    const align = aligns.map((a) => {
      if (/^ *-+: *$/.test(a)) return 'right';
      if (/^ *:-+: *$/.test(a)) return 'center';
      if (/^ *:-+ *$/.test(a)) return 'left';
      return null;
    });
    const tok = { type: 'table', raw: m[0].replace(/\n$/, ''), header: [], align, rows: [] };
    for (let i = 0; i < headerCells.length; i++) {
      const cell = { text: headerCells[i], header: true, align: align[i] };
      this.queueInline(cell, headerCells[i]);
      tok.header.push(cell);
    }
    const body = m[3] ? m[3].replace(/\n[ \t]*$/, '').split('\n') : [];
    for (const line of body) {
      const cells = splitTableRow(line, headerCells.length).map((text, j) => {
        const cell = { text, header: false, align: align[j] };
        this.queueInline(cell, text);
        return cell;
      });
      tok.rows.push(cells);
    }
    return tok;
  }

  trySetext(src) {
    const m = buildSetextRegex().exec(src);
    if (!m) return null;
    const text = m[1].trim();
    const raw = m[0].replace(/\n$/, '');
    const tok = { type: 'heading', raw, depth: m[2].charAt(0) === '=' ? 1 : 2, text };
    this.queueInline(tok, text);
    return tok;
  }

  tryParagraph(src) {
    const m = RE_PARA.exec(src);
    if (!m) return null;
    let text = m[1];
    if (text.charAt(text.length - 1) === '\n') text = text.slice(0, -1);
    const tok = { type: 'paragraph', raw: m[0], text };
    this.queueInline(tok, text);
    return tok;
  }

  tryText(src) {
    const m = RE_TEXT_LINE.exec(src);
    if (!m) return null;
    const tok = { type: 'text', raw: m[0], text: m[0] };
    this.queueInline(tok, m[0]);
    return tok;
  }

  tryBlockquote(src) { return tryBlockquote(this, src); }
  tryList(src) { return tryList(this, src); }
}

// The setext regex needs the "interruption" alternatives baked in; build it
// once, mirroring the paragraph regex's lookahead.
let _setextRe = null;
function buildSetextRegex() {
  if (_setextRe) return _setextRe;
  const bull = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
  const blockCode = '(?: {4}| {0,3}\\t)';
  const fences = ' {0,3}(?:`{3,}|~{3,})';
  const bq = ' {0,3}>';
  const heading = ' {0,3}#{1,6}(?:\\s|$)';
  const hr = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
  const html = ' {0,3}<[^\\n>]+>\\n';
  const table = ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n';
  const body = '((?:.|\\n(?!\\s*?\\n|' + bull + ' |' + blockCode + '|' + fences + '|' + bq + '|' + heading + '|' + hr + '|' + html + '|' + table + '))+?)';
  _setextRe = new RegExp('^' + body + '\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)');
  return _setextRe;
}

// -1 when parens are unbalanced in the "open never closed" way marked
// rejects; otherwise the balance scan result.
function parenBalance(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// ---------------------------------------------------------------------------
// Blockquote and list (the two recursive block constructs)
// ---------------------------------------------------------------------------

const RE_BQ_START = /^ {0,3}>/;
const RE_BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const RE_BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const RE_BQ_STRIP = /^ {0,3}>[ \t]?/gm;
const RE_LIST_START = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const RE_LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const RE_LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const RE_LIST_CHECKBOX = /\[[ xX]\]/;
const RE_LEADING_SPACE_TAB = /^[ \t]+/;
const RE_NON_SPACE = /[^ ]/;
const RE_TAB_GLOBAL = /\t/g;
const RE_SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;
const RE_LIST_NESTING = /^ {1,4}(?=( {4})*[^ ])/g;

function listItemRegex(bulletPat) {
  return new RegExp(`^( {0,3}${bulletPat})((?:[ \t][^\\n]*)?(?:\\n|$))`);
}
// The "a line that would start another block" tests take the item's content
// indent, clamped the way marked's cached regexes do: at most 3, and one
// less than the indent (a block marker sits at most 3 spaces in, and an
// item whose content starts at column 1 admits a marker only at column 0).
function clampIndent(indent) {
  return Math.max(0, Math.min(3, indent - 1));
}
function nextBulletRegex(indent) {
  return new RegExp(`^ {0,${clampIndent(indent)}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`);
}
function hrRegex(indent) {
  return new RegExp(`^ {0,${clampIndent(indent)}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`);
}
function fencesBeginRegex(indent) {
  return new RegExp(`^ {0,${clampIndent(indent)}}(?:\`\`\`|~~~)`);
}
function headingBeginRegex(indent) {
  return new RegExp(`^ {0,${clampIndent(indent)}}#{1,6}(?:\\s|$)`);
}
function htmlBeginRegex(indent) {
  return new RegExp(`^ {0,${clampIndent(indent)}}(?:</?(?:${RE_HTML_BLOCK_TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
}
function blockquoteBeginRegex(indent) {
  return new RegExp(`^ {0,${clampIndent(indent)}}>`);
}

// The blockquote regex: a run of lines, each either a `>` line (whose
// content may itself span paragraph-continuation lines) or any line at all
// (a lazy line, swallowed by the paragraph match of the `>` line above it).
function blockquoteRegex() {
  const para = RE_PARA.source.slice(1); // paragraph pattern without ^
  return new RegExp(`^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(${para})|[^\\n]*)(?:\\n|$))+`);
}

function tryBlockquote(lexer, src) {
  const m = blockquoteRegex().exec(src);
  if (!m) return null;
  const raw0 = m[0].replace(/\n$/, '');
  let lines = raw0.split('\n');
  const tokens = [];
  let rawOut = '';
  let textOut = '';
  while (lines.length > 0) {
    let seenMarker = false;
    const chunk = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (RE_BQ_START.test(lines[p])) { chunk.push(lines[p]); seenMarker = true; }
      else if (!seenMarker) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = chunk.join('\n');
    // Strip markers, expanding a tab after `>` to spaces, and indent a
    // lazy setext underline so it stays paragraph text.
    const u = h
      .replace(RE_BQ_MARKER_WS, (g, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(RE_BQ_SETEXT, '\n    $1')
      .replace(RE_BQ_STRIP, '');
    rawOut = rawOut ? rawOut + '\n' + h : h;
    textOut = textOut ? textOut + '\n' + u : u;
    const savedTop = lexer.state.top;
    lexer.state.top = true;
    lexer.lexBlocks(u, true, tokens, true);
    lexer.state.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (!last) break;
    if (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table') break;
    if (last.type === 'blockquote') {
      const rest = lines.join('\n').replace(RE_BQ_STRIP, '');
      const combined = last.raw + '\n' + rest;
      const re = tryBlockquote(lexer, combined);
      tokens[tokens.length - 1] = re;
      const consumed = combined.substring(re.raw.length).replace(/^\n/, '');
      const consumedLines = consumed ? consumed.split('\n').length : 0;
      const extra = consumedLines === 0 ? lines.slice() : lines.slice(0, -consumedLines);
      if (extra.length > 0) rawOut += '\n' + extra.join('\n');
      textOut = textOut.substring(0, textOut.length - last.text.length) + re.text;
      lines = lines.slice(lines.length - consumedLines);
      if (lines.length > 0 && RE_BQ_START.test(lines[0])) continue;
      break;
    }
    if (last.type === 'list') {
      const rest = lines.join('\n');
      const combined = last.raw + '\n' + rest;
      const re = tryList(lexer, combined);
      tokens[tokens.length - 1] = re;
      const consumed = combined.slice(last.raw.length + 1, re.raw.length).split('\n').length;
      const extra = lines.slice(0, consumed);
      if (extra.length > 0) rawOut += '\n' + extra.join('\n');
      lines = lines.slice(consumed);
      continue;
    }
  }
  return { type: 'blockquote', raw: rawOut, tokens, text: textOut };
}

function tryList(lexer, src) {
  const start = RE_LIST_START.exec(src);
  if (!start) return null;
  const full = src;
  let rest = src;
  const offset = () => full.length - rest.length;
  let bullet = start[1].trim();
  const ordered = bullet.length > 1;
  const listTok = {
    type: 'list', raw: '', ordered,
    start: ordered ? +bullet.slice(0, -1) : '',
    loose: false, items: [],
  };
  bullet = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRe = listItemRegex(bullet);
  let prevDoubleBlank = false;
  while (rest) {
    let isEmptyItem = false;
    let firstLine = '';
    const m = itemRe.exec(rest);
    if (!m || RE_HR.test(rest)) break;
    const itemStart = offset();
    rest = rest.substring(m[0].length);
    let g = m[2].split('\n', 1)[0];
    const bulletWidth = m[1].length;
    let content = g.replace(RE_LEADING_SPACE_TAB, (v) => expandTabs(v, bulletWidth));
    let nextLine = rest.split('\n', 1)[0];
    let emptyFirst = !content.trim();
    let indent = 0;
    let d;
    if (emptyFirst) {
      indent = bulletWidth + 1;
      d = '';
    } else {
      indent = content.search(RE_NON_SPACE);
      if (indent > 4) indent = 1;
      d = content.slice(indent);
      indent += bulletWidth;
    }
    if (emptyFirst && RE_BLANK.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      isEmptyItem = true;
    }
    if (!isEmptyItem) {
      const nextBullet = nextBulletRegex(indent);
      const hrRe = hrRegex(indent);
      const fencesRe = fencesBeginRegex(indent);
      const headingRe = headingBeginRegex(indent);
      const htmlRe = htmlBeginRegex(indent);
      const bqRe = blockquoteBeginRegex(indent);
      while (rest) {
        const line = rest.split('\n', 1)[0];
        nextLine = line;
        const expanded = line.replace(RE_LEADING_SPACE_TAB, (v) => expandTabs(v, 0));
        if (fencesRe.test(line) || headingRe.test(line) || htmlRe.test(line) || bqRe.test(line) || nextBullet.test(line) || hrRe.test(line)) break;
        if (expanded.search(RE_NON_SPACE) >= indent || !line.trim()) {
          d += '\n' + expanded.slice(indent);
        } else {
          if (emptyFirst || content.replace(RE_TAB_GLOBAL, '    ').search(RE_NON_SPACE) >= 4 || fencesRe.test(content) || headingRe.test(content) || htmlRe.test(content) || hrRe.test(content)) break;
          const setextCandidate = RE_SETEXT_LINE.test(line) && buildSetextRegex().test(content + '\n' + line);
          if (setextCandidate) d += '\n    ' + expanded.replace(/^ {0,3}/, '');
          else d += '\n' + line;
        }
        emptyFirst = !line.trim();
        rest = rest.substring(line.length + 1);
        content = expanded.slice(indent);
      }
    }
    const itemRaw = full.slice(itemStart, offset());
    if (!listTok.loose) {
      if (prevDoubleBlank) listTok.loose = true;
      else if (RE_DOUBLE_BLANK.test(itemRaw)) prevDoubleBlank = true;
    }
    listTok.items.push({
      type: 'list_item', raw: itemRaw,
      task: !!RE_LIST_IS_TASK.test(d), loose: false, text: d, tokens: [],
    });
  }
  const lastItem = listTok.items[listTok.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  listTok.raw = full.slice(0, offset()).trimEnd();
  // Lex each item's content as blocks.
  for (const item of listTok.items) {
    lexer.state.top = false;
    item.tokens = lexer.lexBlocks(item.text, false);
    if (!listTok.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      if (spaces.length > 0 && spaces.some((t) => /\n.*\n/.test(t.raw))) listTok.loose = true;
    }
  }
  // Task list items: strip the checkbox marker, prepend a checkbox token.
  for (const item of listTok.items) {
    const first = item.tokens[0];
    if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
      item.text = item.text.replace(RE_LIST_REPLACE_TASK, '');
      first.raw = first.raw.replace(RE_LIST_REPLACE_TASK, '');
      first.text = first.text.replace(RE_LIST_REPLACE_TASK, '');
      for (let q = lexer.inlineQueue.length - 1; q >= 0; q--) {
        if (RE_LIST_IS_TASK.test(lexer.inlineQueue[q].src)) {
          lexer.inlineQueue[q].src = lexer.inlineQueue[q].src.replace(RE_LIST_REPLACE_TASK, '');
          break;
        }
      }
      const cb = RE_LIST_CHECKBOX.exec(item.raw);
      if (cb) {
        const checked = cb[0] !== '[ ]';
        const box = { type: 'checkbox', raw: cb[0] + ' ', checked };
        item.checked = checked;
        if (listTok.loose && first && (first.type === 'paragraph' || first.type === 'text') && first.tokens) {
          first.raw = box.raw + first.raw;
          first.text = box.raw + first.text;
          first.tokens.unshift(box);
        } else if (listTok.loose) {
          item.tokens.unshift({ type: 'paragraph', raw: box.raw, text: box.raw, tokens: [box] });
        } else {
          item.tokens.unshift(box);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (listTok.loose) {
    for (const item of listTok.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
  }
  return listTok;
}

// ---------------------------------------------------------------------------
// Inline lexer: a single left-to-right scan with a delimiter stack.
// ---------------------------------------------------------------------------

const RE_CODE_SPAN_OPEN = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const RE_AUTOLINK = /^<(?:([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*)|([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+))>/;
const RE_INLINE_TAG = new RegExp(
  '^<!--(?:-?>|[\\s\\S]*?-->)' +
  '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' +
  '|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?)*?\\s*/?>' +
  '|^<\\?[\\s\\S]*?\\?>' +
  '|^<![a-zA-Z]+\\s[\\s\\S]*?>' +
  '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>');
const RE_START_A_TAG = /^<a /i;
const RE_END_A_TAG = /^<\/a>/i;
const RE_START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const RE_END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
const RE_EMAIL_LOCAL = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]/;
const RE_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:\/\//;
const RE_URL_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const RE_URL_EMAIL = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
// Same email, without the trailing (?![\w-]) lookahead: the maximal match.
const RE_EMAIL_NOLOOK = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+/;
const RE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const RE_WS = /\s/;
const RE_PUNCT_TEST = /[\p{P}\p{S}]/u;

const RE_UNICODE_WS = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
// Whitespace the way marked's \s sees it (ASCII whitespace plus the
// Unicode spaces, including U+00A0): CommonMark flanking and hard-break
// checks treat NBSP as whitespace.
function isSpace(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || (ch !== undefined && RE_UNICODE_WS.test(ch)); }
function isPunct(ch) { return ch !== undefined && RE_PUNCT_TEST.test(ch); }
// ASCII punctuation only (CommonMark backslash escapes): « and other
// non-ASCII punctuation are NOT escapable.
const RE_ASCII_PUNCT = /[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~]/;
function isAsciiPunct(ch) { return ch !== undefined && RE_ASCII_PUNCT.test(ch); }

// Flanking of a delimiter run: `before` is the char before the run,
// `after` the char after it. `punct` decides which chars count as
// punctuation (for `~` the tilde itself does not).
function flanking(before, after, punct) {
  const beforeWS = before === undefined || before === '\n' || isSpace(before);
  const afterWS = after === undefined || after === '\n' || isSpace(after);
  const beforePunct = punct(before);
  const afterPunct = punct(after);
  const left = !afterWS && (!afterPunct || beforeWS || beforePunct);
  const right = !beforeWS && (!beforePunct || afterWS || afterPunct);
  return { left, right, beforePunct, afterPunct };
}

function canOpenDelim(char, f) {
  if (char === '*') return f.left;
  if (char === '_') return f.left && (!f.right || f.beforePunct);
  return f.left;
}
function canCloseDelim(char, f) {
  if (char === '*') return f.right;
  if (char === '_') return f.right && (!f.left || f.afterPunct);
  return f.right;
}

// Parse a title + closing paren after a destination that ends at `j`.
// Returns {title, end} or null.
function parseLinkTail(src, j) {
  const n = src.length;
  let title = '';
  let k = j;
  while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
  if (src[k] === '\n') {
    let m = k + 1;
    while (m < n && (src[m] === ' ' || src[m] === '\t')) m++;
    k = m;
  }
  if (src[k] === '"' || src[k] === "'" || src[k] === '(') {
    const open = src[k];
    const close = open === '(' ? ')' : open;
    let m = k + 1;
    let ok = false;
    while (m < n) {
      const ch = src[m];
      if (ch === '\\') { m += 2; continue; }
      if (ch === close) { ok = true; break; }
      // A single-quoted title may not contain a blank line.
      if (open === "'" && ch === '\n' && src[m + 1] === '\n') break;
      m++;
    }
    if (!ok) return null;
    title = src.slice(k + 1, m);
    k = m + 1;
  }
  while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
  if (k >= n || src[k] !== ')') return null;
  return { title, end: k + 1 };
}

// Try to parse an inline link destination + title starting at `src[i]`
// (which must be `(`). Returns {href, title, end} or null. The angle
// form is tried first; when it fails the bare form is tried, as the
// reference regex's backtracking would.
function parseLinkDestination(src, i) {
  let j = i + 1;
  const n = src.length;
  while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
  // Angle destination <...>.
  if (src[j] === '<') {
    let k = j + 1;
    while (k < n && src[k] !== '\n' && src[k] !== '<' && src[k] !== '>') {
      if (src[k] === '\\') k++;
      k++;
    }
    if (k < n && src[k] === '>') {
      const tail = parseLinkTail(src, k + 1);
      if (tail) return { href: src.slice(j, k + 1), title: tail.title, end: tail.end };
    }
  }
  // Bare destination: no spaces, balanced parens, no control chars.
  let depth = 0;
  let k = j;
  while (k < n) {
    const ch = src[k];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch.charCodeAt(0) < 0x20) break;
    if (ch === '\\') { k += 2; continue; }
    if (ch === '(') { depth++; k++; continue; }
    if (ch === ')') {
      if (depth === 0) break;
      depth--; k++; continue;
    }
    k++;
  }
  if (depth !== 0) return null;
  const tail = parseLinkTail(src, k);
  if (!tail) return null;
  return { href: src.slice(j, k), title: tail.title, end: tail.end };
}

// Scan for the `]` closing a link label that starts at `src[i]` (`[`).
// Returns the index of the matching `]` or -1. Nested brackets count;
// code spans are skipped.
function findLabelEnd(src, i) {
  let depth = 0;
  let j = i;
  const n = src.length;
  while (j < n) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '`') {
      let k = j;
      while (k < n && src[k] === '`') k++;
      // A code span inside a label closes at the next backtick run of any
      // length (marked's label regex allows unequal runs, e.g. ``x`). A
      // run with no later run is literal only when it is 2+ backticks
      // right before `]`; otherwise the label cannot close at all.
      let m = k;
      let found = -1;
      while (m < n) {
        if (src[m] === '`') {
          while (m < n && src[m] === '`') m++;
          found = m;
          break;
        }
        m++;
      }
      if (found === -1) {
        if (k - j >= 2 && src[k] === ']') { j = k; continue; }
        return -1;
      }
      j = found;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return j;
    }
    j++;
  }
  return -1;
}

// Does `text` contain a `<` that starts a tag/autolink running past the
// end of the label? (marked refuses such links.)
function labelHasRunawayTag(src, labelStart, labelEnd) {
  for (let i = labelStart; i < labelEnd; i++) {
    if (src[i] !== '<') continue;
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '`') {
      const m = RE_CODE_SPAN_OPEN.exec(src.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    const sub = src.slice(i);
    const tag = RE_INLINE_TAG.exec(sub) || RE_AUTOLINK.exec(sub);
    if (tag && tag[0].length > labelEnd - i) return true;
  }
  return false;
}

// Try to form a link/image from a `[` at `src[i]`. `image` is true when the
// `[` is preceded by `!`. Returns {node, end} or null (not a link: the `[`
// stays literal text).
function tryLink(src, i, image, lexer) {
  const labelEnd = findLabelEnd(src, i);
  if (labelEnd === -1) return null;
  const label = src.slice(i + 1, labelEnd);
  if (labelHasRunawayTag(src, i + 1, labelEnd)) return null;
  const after = labelEnd + 1;
  // Inline link: (destination "title"). When the parenthesised form does
  // not parse, the reference forms are still tried on the label itself.
  if (src[after] === '(') {
    const dest = parseLinkDestination(src, after);
    if (dest) {
      let href = dest.href;
      // A destination starting with `<` must end with an unescaped `>`;
      // otherwise the inline form fails and the shortcut is tried.
      if (href.startsWith('<')) {
        if (!href.endsWith('>')) return shortcutLink(src, i, labelEnd, label, image, lexer);
        const base = href.slice(0, -1);
        let k = base.length;
        while (k > 0 && base[k - 1] === '\\') k--;
        if ((href.length - k) % 2 === 0) return shortcutLink(src, i, labelEnd, label, image, lexer);
        href = href.slice(1, -1);
      }
      return makeLink(src, i, labelEnd, label, { href: unescapeBackslash(href), title: dest.title ? unescapeBackslash(dest.title) : '' }, dest.end, image, lexer);
    }
    return shortcutLink(src, i, labelEnd, label, image, lexer);
  }
  // Reference link: [label][ref], [label][], or shortcut [label].
  if (src[after] === '[') {
    let refEnd = -1;
    let ref = label;
    if (src[after + 1] === ']') {
      refEnd = after + 1;
    } else {
      let j = after + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === ']' || src[j] === '[' || src[j] === '\n') break;
        j++;
      }
      if (j < src.length && src[j] === ']') {
        refEnd = j;
        ref = src.slice(after + 1, j);
      }
    }
    if (refEnd === -1) {
      // No closing bracket: try the shortcut form on the label itself.
      return shortcutLink(src, i, labelEnd, label, image, lexer);
    }
    const target = lexer.links[normalizeLabel(ref)];
    if (!target) return { literal: image ? '!' : '[', end: i + 1 };
    return makeLink(src, i, labelEnd, label, target, refEnd + 1, image, lexer);
  }
  return shortcutLink(src, i, labelEnd, label, image, lexer);
}

function shortcutLink(src, i, labelEnd, label, image, lexer) {
  const target = lexer.links[normalizeLabel(label)];
  if (!target) return { literal: image ? '!' : '[', end: i + 1 };
  return makeLink(src, i, labelEnd, label, target, labelEnd + 1, image, lexer);
}

// Build a link/image node, parsing the label as inline content. Returns
// null when the label itself contains a link (a link cannot contain one).
function makeLink(src, i, labelEnd, label, target, end, image, lexer) {
  const state = lexer.state;
  const savedInLink = state.inLink;
  const savedEmitted = state.linkEmitted;
  state.inLink = true;
  state.linkEmitted = false;
  const labelTokens = parseInline(label, lexer);
  const hadLink = state.linkEmitted;
  state.linkEmitted = savedEmitted;
  state.inLink = savedInLink;
  if (!image && hadLink) return null;
  if (!image) state.linkEmitted = true;
  return {
    node: {
      type: image ? 'image' : 'link',
      raw: src.slice(i, end), href: target.href, title: target.title || null,
      text: label, tokens: labelTokens,
    },
    end,
  };
}

// Process the delimiter stack into em/strong/del nodes (CommonMark
// appendix A, phase 2). `nodes` is mutated in place; delimiters reference
// their node objects.
function processEmphasis(nodes, delims) {
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (!closer.active || closer.len === 0 || !closer.canClose) continue;
    while (closer.len > 0) {
      // Find the nearest earlier opener of the same kind.
      let opener = null;
      let openerIdx = -1;
      for (let oi = ci - 1; oi >= 0; oi--) {
        const o = delims[oi];
        if (!o.active || o.len === 0 || o.char !== closer.char || !o.canOpen) continue;
        if (closer.char === '~') {
          if (o.len !== closer.len) continue;
        } else if ((o.canClose && o.canOpen) || (closer.canClose && closer.canOpen)) {
          // The rule of three: when either side can both open and close,
          // the two runs' lengths must not sum to a multiple of 3, UNLESS
          // both lengths are themselves multiples of 3.
          if ((o.len + closer.len) % 3 === 0 && (o.len % 3 !== 0 || closer.len % 3 !== 0)) continue;
        }
        opener = o;
        openerIdx = oi;
        break;
      }
      if (!opener) break;
      const use = closer.char === '~' ? closer.len : (opener.len >= 2 && closer.len >= 2 ? 2 : 1);
      const type = closer.char === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
      const openerNode = opener.node;
      const closerNode = closer.node;
      const oi = nodes.indexOf(openerNode);
      const cj = nodes.indexOf(closerNode);
      // Trim the used delimiters off their text nodes.
      openerNode.text = openerNode.text.slice(0, openerNode.text.length - use);
      openerNode.raw = openerNode.text;
      closerNode.text = closerNode.text.slice(use);
      closerNode.raw = closerNode.text;
      opener.len -= use;
      closer.len -= use;
      if (opener.len === 0) opener.active = false;
      if (closer.len === 0) closer.active = false;
      // Delimiters between opener and closer are now inside the new node.
      for (let k = openerIdx + 1; k < ci; k++) {
        const d = delims[k];
        if (d.node !== openerNode && d.node !== closerNode && nodes.indexOf(d.node) > oi && nodes.indexOf(d.node) < cj) d.active = false;
      }
      const middle = nodes.slice(oi + 1, cj);
      const newNode = { type, raw: '', text: '', tokens: middle };
      const before = nodes.slice(0, oi);
      const after = nodes.slice(cj + 1);
      if (openerNode.text.length > 0) before.push(openerNode);
      if (closerNode.text.length > 0) after.unshift(closerNode);
      nodes.length = 0;
      nodes.push(...before, newNode, ...after);
      if (closer.char === '~') break; // del consumes the whole run at once
    }
  }
  // Merge adjacent plain text nodes left over from trimming.
  for (let k = 1; k < nodes.length; k++) {
    const a = nodes[k - 1];
    const b = nodes[k];
    if (a.type === 'text' && b.type === 'text' && !a.tokens && !b.tokens && !a._delim && !b._delim) {
      a.text += b.text;
      a.raw += b.raw;
      nodes.splice(k, 1);
      k--;
    }
  }
}

// The inline parser: one left-to-right scan.
function parseInline(src, lexer) {
  const links = lexer.links;
  const state = lexer.state;
  state.inRawBlock = false;
  const nodes = [];
  const delims = [];
  let i = 0;
  const n = src.length;
  let textStart = 0;
  let skipImageAt = -1; // a `[` already tried (and failed) as an image

  function flushText(upto) {
    if (upto <= textStart) { textStart = upto; return; }
    let t = src.slice(textStart, upto);
    if (!state.inRawBlock) t = decodeEntities(t);
    const last = nodes[nodes.length - 1];
    if (last && last.type === 'text' && !last.tokens && !last._delim) {
      last.text += t;
      last.raw += t;
    } else {
      nodes.push({ type: 'text', raw: t, text: t });
    }
    textStart = upto;
  }

  function pushDelim(char, runStart, runLen) {
    flushText(runStart);
    const before = runStart === 0 ? '\n' : src[runStart - 1];
    const after = runStart + runLen >= n ? '\n' : src[runStart + runLen];
    const punct = char === '~' ? (c) => c !== '~' && isPunct(c) : isPunct;
    const f = flanking(before, after, punct);
    const node = { type: 'text', raw: src.slice(runStart, runStart + runLen), text: src.slice(runStart, runStart + runLen), _delim: true };
    nodes.push(node);
    if (char === '~' && runLen > 2) {
      // Runs of 3+ tildes are never strikethrough delimiters.
      node._delim = false;
    } else {
      delims.push({ char, len: runLen, canOpen: canOpenDelim(char, f), canClose: canCloseDelim(char, f), node, active: true });
    }
    textStart = runStart + runLen;
  }

  // Match a GFM extended-autolink email at the start of `sub`.
  // Returns the matched text or null. marked consumes an enclosing
  // emphasis span before it ever sees the email, so a trailing `_` that
  // closes an open emphasis must not cut the domain short the way the
  // (?![\w-]) lookahead otherwise would (e.g. `_a@b.co_` links the whole
  // address, while a bare `a@b.co_` links only `a@b`).
  function matchEmail(sub) {
    const full = RE_EMAIL_NOLOOK.exec(sub);
    if (!full) return null;
    const strict = RE_URL_EMAIL.exec(sub);
    if (strict && strict[0].length === full[0].length) return strict[0];
    const after = sub[full[0].length];
    if (after !== '_') return strict ? strict[0] : null;
    let k = full[0].length;
    while (k < sub.length && sub[k] === '_') k++;
    const f = flanking(full[0][full[0].length - 1], k >= sub.length ? '\n' : sub[k], isPunct);
    if (!canCloseDelim('_', f)) return strict ? strict[0] : null;
    for (const d of delims) if (d.active && d.char === '_' && d.canOpen) return full[0];
    return strict ? strict[0] : null;
  }

  while (i < n) {
    const ch = src[i];
    // Backslash escape / hard break.
    if (ch === '\\') {
      const nxt = src[i + 1];
      if (nxt === '\n') {
        // Hard break, unless the rest is only whitespace.
        let hasNonWS = false;
        for (let k = i + 2; k < n; k++) if (!isSpace(src[k])) { hasNonWS = true; break; }
        if (hasNonWS) {
          flushText(i);
          nodes.push({ type: 'br', raw: '\\\n' });
          i += 2;
          while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      if (nxt !== undefined && isAsciiPunct(nxt)) {
        flushText(i);
        nodes.push({ type: 'escape', raw: src.slice(i, i + 2), text: nxt });
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // Code span.
    if (ch === '`') {
      let k = i;
      while (k < n && src[k] === '`') k++;
      const run = k - i;
      let m = k;
      let close = -1;
      while (m < n) {
        if (src[m] === '`') {
          let e = m;
          while (e < n && src[e] === '`') e++;
          if (e - m === run) { close = e; break; }
          m = e;
        } else m++;
      }
      if (close !== -1) {
        flushText(i);
        let content = src.slice(k, close - run).replace(/\n/g, ' ');
        if (/[^ ]/.test(content) && content.startsWith(' ') && content.endsWith(' ')) content = content.slice(1, -1);
        nodes.push({ type: 'codespan', raw: src.slice(i, close), text: content });
        i = close;
        textStart = i;
        continue;
      }
      i = k;
      continue;
    }
    // Emphasis / strikethrough delimiter run.
    if (ch === '*' || ch === '_' || ch === '~') {
      let k = i;
      while (k < n && src[k] === ch) k++;
      pushDelim(ch, i, k - i);
      i = k;
      continue;
    }
    // Link / image. An escaped `!` does not make an image.
    if (ch === '[') {
      let image = i !== skipImageAt && i > 0 && src[i - 1] === '!';
      if (image) {
        let bs = 0;
        for (let p = i - 2; p >= 0 && src[p] === '\\'; p--) bs++;
        if (bs % 2 === 1) image = false;
      }
      const res = tryLink(src, i, image, lexer);
      if (res && res.node) {
        flushText(image ? i - 1 : i);
        nodes.push(res.node);
        i = res.end;
        textStart = i;
        continue;
      }
      if (res && res.literal) {
        if (image) {
          // Undefined reference: only the `!` is literal text; the `[`
          // is scanned again on the next pass, as a plain link.
          flushText(i - 1);
          nodes.push({ type: 'text', raw: '!', text: '!' });
          textStart = i;
          skipImageAt = i;
          continue;
        }
        flushText(i);
        nodes.push({ type: 'text', raw: '[', text: '[' });
        i += 1;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // Raw HTML tag / autolink.
    if (ch === '<') {
      const sub = src.slice(i);
      const auto = RE_AUTOLINK.exec(sub);
      if (auto) {
        flushText(i);
        const isEmail = auto[2] !== undefined;
        const addr = isEmail ? auto[2] : auto[1];
        const href = isEmail ? 'mailto:' + addr : addr;
        nodes.push({ type: 'link', raw: auto[0], text: addr, href, title: null, autolink: true, tokens: [{ type: 'text', raw: addr, text: addr }] });
        i += auto[0].length;
        textStart = i;
        continue;
      }
      const tag = RE_INLINE_TAG.exec(sub);
      if (tag) {
        flushText(i);
        if (!state.inLink && RE_START_A_TAG.test(tag[0])) state.inLink = true;
        else if (state.inLink && RE_END_A_TAG.test(tag[0])) state.inLink = false;
        if (!state.inRawBlock && RE_START_PRE_TAG.test(tag[0])) state.inRawBlock = true;
        else if (state.inRawBlock && RE_END_PRE_TAG.test(tag[0])) state.inRawBlock = false;
        nodes.push({ type: 'html', raw: tag[0], text: tag[0], block: false, inLink: state.inLink, inRawBlock: state.inRawBlock });
        i += tag[0].length;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // Hard break: two or more spaces before a newline.
    if (ch === '\n') {
      let spaces = 0;
      for (let k = i - 1; k >= textStart && src[k] === ' '; k--) spaces++;
      let hasNonWS = false;
      for (let k = i + 1; k < n; k++) if (!isSpace(src[k])) { hasNonWS = true; break; }
      if (spaces >= 2 && hasNonWS) {
        flushText(i - spaces);
        nodes.push({ type: 'br', raw: src.slice(i - spaces, i + 1) });
        i += 1;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // GFM extended autolinks (not inside a link).
    if (!state.inLink && (ch === 'w' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || RE_EMAIL_LOCAL.test(ch))) {
      const sub = src.slice(i);
      let m = null;
      let kind = null;
      let text = null;
      if (ch === 'w' && sub.startsWith('www.') && (i === 0 || ' \t\n*_~('.includes(src[i - 1]))) {
        m = /^(www\.(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*)/.exec(sub);
        if (m) { kind = 'www'; text = m[0]; }
      } else if (RE_SCHEME.test(sub)) {
        m = /^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*)/.exec(sub);
        if (m) { kind = 'scheme'; text = m[0]; }
      }
      if (!m) {
        // Plain email: no preceding-character check (marked has none:
        // `x@y@z.com` links `y@z.com`).
        const emText = matchEmail(sub);
        if (emText) {
          m = { 0: emText };
          kind = 'email';
          text = emText;
        } else if (sub.startsWith('xmpp:') || sub.startsWith('mailto:')) {
          const proto = sub.startsWith('xmpp:') ? 'xmpp:' : 'mailto:';
          const em2 = matchEmail(sub.slice(proto.length));
          if (em2) {
            let t = proto + em2;
            if (proto === 'xmpp:') {
              const path = /^\/[A-Za-z0-9@.]+/.exec(sub.slice(t.length));
              if (path) t += path[0];
            }
            m = { 0: t };
            kind = 'protocol-email';
            text = t;
          }
        }
      }
      if (m) {
        // Backpedal trailing punctuation / unbalanced parens / entities.
        let url = text;
        let prev;
        do {
          prev = url;
          const bp = RE_URL_BACKPEDAL.exec(url);
          url = bp ? bp[0] : '';
        } while (url !== prev);
        if (url.length > 0) {
          flushText(i);
          const href = kind === 'www' ? 'http://' + url : kind === 'email' ? 'mailto:' + url : url;
          nodes.push({ type: 'link', raw: url, text: url, href, title: null, autolink: true, tokens: [{ type: 'text', raw: url, text: url }] });
          i += url.length;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  flushText(n);
  processEmphasis(nodes, delims);
  return nodes;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function renderInline(tokens, plain) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'escape':
        out += plain ? t.text : escapeHtml(t.text, false);
        break;
      case 'html':
        out += t.text;
        break;
      case 'link': {
        if (plain) { out += renderInline(t.tokens, true); break; }
        const text = t.autolink ? escapeHtml(t.text, true) : renderInline(t.tokens, false);
        const href = encodeHref(t.href);
        if (href === null) { out += text; break; }
        out += '<a href="' + escapeHtml(href, t.autolink) + '"';
        if (t.title) out += ' title="' + escapeHtml(t.title, false) + '"';
        out += '>' + text + '</a>';
        break;
      }
      case 'image': {
        if (plain) { out += renderInline(t.tokens, true); break; }
        const alt = renderInline(t.tokens, true);
        const href = encodeHref(t.href);
        if (href === null) { out += escapeHtml(alt, false); break; }
        out += '<img src="' + escapeHtml(href, false) + '" alt="' + escapeHtml(alt, false) + '"';
        if (t.title) out += ' title="' + escapeHtml(t.title, false) + '"';
        out += '>';
        break;
      }
      case 'checkbox':
        out += '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'strong':
        out += plain ? renderInline(t.tokens, true) : '<strong>' + renderInline(t.tokens, false) + '</strong>';
        break;
      case 'em':
        out += plain ? renderInline(t.tokens, true) : '<em>' + renderInline(t.tokens, false) + '</em>';
        break;
      case 'codespan':
        out += plain ? t.text : '<code>' + escapeHtml(t.text, true) + '</code>';
        break;
      case 'br':
        out += plain ? '' : '<br>';
        break;
      case 'del':
        out += plain ? renderInline(t.tokens, true) : '<del>' + renderInline(t.tokens, false) + '</del>';
        break;
      case 'text':
        if (t.tokens) out += renderInline(t.tokens, plain);
        else if (plain) out += t.text;
        else if (t.escaped) out += t.text;
        else out += escapeHtml(t.text, false);
        break;
      default:
        break;
    }
  }
  return out;
}

function renderBlocks(tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${t.depth}>${renderInline(t.tokens, false)}</h${t.depth}>\n`;
        break;
      case 'code': {
        const lang = (t.lang || '').match(/^\S*/)?.[0] || '';
        let text = t.text ? t.text.replace(/\n$/, '') + '\n' : '';
        out += lang
          ? `<pre><code class="language-${escapeHtml(lang, false)}">${escapeHtml(text, true)}</code></pre>\n`
          : `<pre><code>${escapeHtml(text, true)}</code></pre>\n`;
        break;
      }
      case 'table': {
        let head = '';
        for (const c of t.header) head += tableCell(c);
        let body = '';
        for (const row of t.rows) {
          let cells = '';
          for (const c of row) cells += tableCell(c);
          body += `<tr>\n${cells}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${body}</table>\n`;
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(t.tokens)}</blockquote>\n`;
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const start = t.ordered && t.start !== 1 ? ` start="${t.start}"` : '';
        let items = '';
        for (const item of t.items) items += `<li>${renderBlocks(item.tokens)}</li>\n`;
        out += `<${tag}${start}>\n${items}</${tag}>\n`;
        break;
      }
      case 'checkbox':
        out += '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'html':
        out += t.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += `<p>${renderInline(t.tokens, false)}</p>\n`;
        break;
      case 'text':
        out += renderInline(t.tokens, false);
        break;
      default:
        break;
    }
  }
  return out;
}

function tableCell(c) {
  const tag = c.header ? 'th' : 'td';
  const align = c.align ? ` align="${c.align}"` : '';
  return `<${tag}${align}>${renderInline(c.tokens, false)}</${tag}>\n`;
}

// The entry point: the HTML marked 18.1.3 renders for `markdown`.
export function parse(markdown) {
  const lexer = new BlockLexer();
  const tokens = lexer.lexDocument(markdown);
  return renderBlocks(tokens);
}
