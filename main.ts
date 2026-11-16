// Driver for markdown-render-speed-02 (program/v1).
//
// Reads every case from /input/cases.json — a JSON array of
// {"id", "markdown"} in order — renders each with parse.js, and writes
// /output/html.json — a JSON array of the HTML strings, in the cases'
// order. Dependency-free; the only import is the entry's own parse.js.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from './parse.js';

const cases = JSON.parse(readFileSync('/input/cases.json', 'utf8'));
const html: string[] = cases.map((c: { id: string; markdown: string }) => parse(c.markdown));
mkdirSync('/output', { recursive: true });
writeFileSync('/output/html.json', JSON.stringify(html));
