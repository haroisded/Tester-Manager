// Test documents in the sample-structure/resources.md format: split into tests, render the small
// markdown subset they use. Run `node md.js` for the self-check.
const TEST_HEADING = /^## Test (\d+)\s*[-–—]\s*Title:\s*(.+)$/gm;
// "Resources — acceptance tests" → "Resources" (requested: the document name alone).
const cleanTitle = t => t.replace(/\s*[-–—:|]?\s*acceptance tests?\s*$/i, '').trim() || 'Untitled tests';

function parseSuite(md) {
  md = md.replace(/\r\n?/g, '\n');
  const heads = [...md.matchAll(TEST_HEADING)];
  if (!heads.length) throw new Error('No tests found. Each test must start with a line like "## Test 1 - Title: ..."');
  const before = md.slice(0, heads[0].index);
  return {
    title: cleanTitle(before.match(/^# (.+)$/m)?.[1] ?? ''),
    intro: before.replace(/^# .+$/m, '').trim(),
    tests: heads.map((h, i) => ({
      num: Number(h[1]),
      title: h[2].trim(),
      body: md.slice(h.index + h[0].length, heads[i + 1]?.index).trim(),
    })),
  };
}

const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

// Headings, - and 1. lists (indented lines continue the previous item), **bold**, paragraphs.
// HTML in the source is escaped, never passed through.
function renderMd(text) {
  const out = [];
  let para = [], list = null, items = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    if (list) out.push(`<${list}>${items.map(i => `<li>${inline(i)}</li>`).join('')}</${list}>`);
    para = []; list = null; items = [];
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    let m;
    if (!line.trim()) flush();
    else if ((m = line.match(/^#{1,6}\s+(.*)/))) { flush(); out.push(`<h4>${inline(m[1])}</h4>`); }
    else if ((m = line.match(/^\s*([-*]|\d+\.)\s+(.*)/))) {
      const type = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (list !== type) { flush(); list = type; }
      items.push(m[2]);
    } else if (list && /^\s/.test(line)) items[items.length - 1] += ' ' + line.trim();
    else { if (list) flush(); para.push(line.trim()); }
  }
  flush();
  return out.join('\n');
}

// ---------- the other direction: the editor's fields <-> markdown ----------
// A test body is four "### " sections. Anything else in it (an older document, a hand-written
// heading) is kept verbatim in `extra` so editing a test never silently drops part of it.
const SECTIONS = ['What will be tested?', 'What do you need before starting?', 'Steps', "What's the expected output?"];

function splitBody(md) {
  const parts = String(md ?? '').replace(/\r\n?/g, '\n').split(/^###[ \t]+(.+)$/m);
  const sections = {}, extra = [];
  if (parts[0].trim()) extra.push(parts[0].trim());
  for (let i = 1; i < parts.length; i += 2) {
    const head = parts[i].trim();
    const body = (parts[i + 1] ?? '').trim();
    if (SECTIONS.includes(head) && !(head in sections)) sections[head] = body;
    else extra.push(`### ${head}\n\n${body}`.trim());
  }
  return { sections, extra: extra.join('\n\n') };
}

const clean = v => String(v ?? '').replace(/\r\n?/g, '\n').trim();

function buildTestMd(num, title, sections = {}, extra = '') {
  const out = [`## Test ${num} - Title: ${clean(title)}`];
  for (const head of SECTIONS) {
    if (clean(sections[head])) out.push(`### ${head}`, clean(sections[head]));
  }
  if (clean(extra)) out.push(clean(extra));
  return out.join('\n\n');
}

function buildSuiteMd({ title, intro, tests }) {
  const out = [`# ${clean(title)}`];
  if (clean(intro)) out.push(clean(intro));
  for (const [i, t] of tests.entries()) out.push(buildTestMd(i + 1, t.title, t.sections, t.extra));
  return `${out.join('\n\n')}\n`;
}

module.exports = { parseSuite, renderMd, cleanTitle, SECTIONS, splitBody, buildTestMd, buildSuiteMd };

if (require.main === module) {
  const assert = require('node:assert');
  const sample = require('node:fs').readFileSync(`${__dirname}/sample-structure/resources.md`, 'utf8');
  const s = parseSuite(sample);
  assert.equal(s.title, 'Resources');
  assert.equal(cleanTitle('Checkout: Acceptance Test'), 'Checkout');
  assert.equal(cleanTitle('Acceptance tests'), 'Untitled tests');
  assert.equal(s.tests.length, 25);
  assert.deepEqual([s.tests[0].num, s.tests[0].title], [1, 'Resources opens and closes its three screens']);
  assert.match(renderMd(s.intro), /^<p>Covers the <strong>Resources<\/strong>.* and <strong>Inventory<\/strong>, with/);
  assert.match(renderMd(s.tests[1].body), /permanent rail, collapsed to icons\./);
  assert.match(renderMd(s.tests[24].body), /<ol><li>On the phone, reach <strong>Review<\/strong>/);
  assert.equal(renderMd('<script>x</script>'), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
  assert.equal(parseSuite(sample.replace(/\n/g, '\r\n')).tests.length, 25);
  assert.throws(() => parseSuite('# nothing here'));

  // Editor round-trip: fields -> markdown -> fields must survive every test in the sample.
  const fields = s.tests.map(t => ({ title: t.title, ...splitBody(t.body) }));
  assert.deepEqual(Object.keys(fields[0].sections), SECTIONS);
  assert.equal(fields[0].extra, '');
  const again = parseSuite(buildSuiteMd({ title: s.title, intro: s.intro, tests: fields }));
  assert.equal(again.title, s.title);
  assert.equal(again.tests.length, s.tests.length);
  assert.deepEqual(again.tests.map(t => [t.num, t.title]), s.tests.map((t, i) => [i + 1, t.title]));
  for (const [i, t] of again.tests.entries()) assert.deepEqual(splitBody(t.body), splitBody(s.tests[i].body));
  assert.equal(renderMd(again.tests[0].body), renderMd(s.tests[0].body));
  // An unknown heading is carried through instead of dropped.
  const odd = splitBody('### Steps\n1. Go\n\n### Notes\nkeep me');
  assert.equal(odd.sections.Steps, '1. Go');
  assert.equal(odd.extra, '### Notes\n\nkeep me');
  assert.match(buildTestMd(3, 'T', odd.sections, odd.extra), /### Notes\n\nkeep me$/);
  console.log('md.js: all checks passed');
}
