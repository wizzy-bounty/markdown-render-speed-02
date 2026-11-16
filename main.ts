// Driver for the markdown-render-speed-02 harness.
//
// Reads every case from /input/cases.json — a JSON array of
// {"id", "markdown"} objects — renders each one with parse() from
// ./parse.js, and writes /output/html.json: a JSON array of the HTML
// strings, in the cases' order. Runs under Node 22, which strips
// TypeScript types natively, so only erasable syntax is used here.
// The output is one JSON array; the scorer compares each string
// with marked's HTML for the same case, in order.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parse } from "./parse.js";

const cases = JSON.parse(readFileSync("/input/cases.json", "utf8"));
const html = cases.map((c) => parse(c.markdown));
mkdirSync("/output", { recursive: true });
writeFileSync("/output/html.json", JSON.stringify(html));
