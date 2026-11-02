'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isBrowserTitle, tabsFrom, formFieldsFrom, safeAddress, normalizeAction } = require('../../src/main/browser');

test('browser detection covers Chrome, Edge, Firefox, Brave, Opera, Vivaldi', () => {
  for (const t of ['Docs - Google Chrome', 'Mail - Microsoft Edge', 'News - Mozilla Firefox', 'X - Brave', 'A - Opera', 'B - Vivaldi']) {
    assert.equal(isBrowserTitle(t), true, t);
  }
  assert.equal(isBrowserTitle('notes.txt - Notepad'), false);
  assert.equal(isBrowserTitle(''), false);
});

test('browser tab and form extraction only keeps relevant named controls', () => {
  const els = [
    { name: 'Docs', type: 'TabItem', x: 1, y: 2, w: 3, h: 4 },
    { name: 'Address and search bar', type: 'Edit', x: 1, y: 2, w: 3, h: 4 },
    { name: 'Sign in', type: 'Button' },
    { name: 'Email', type: 'Edit' },
    { name: 'Remember me', type: 'CheckBox' },
  ];
  assert.deepEqual(tabsFrom(els).map((t) => t.name), ['Docs']);
  assert.deepEqual(formFieldsFrom(els).map((f) => f.name), ['Address and search bar', 'Email', 'Remember me']);
});

test('browser address only accepts http and https', () => {
  assert.equal(safeAddress('https://example.com/a b'), 'https://example.com/a%20b');
  assert.equal(safeAddress('http://127.0.0.1:3000'), 'http://127.0.0.1:3000/');
  assert.equal(safeAddress('file:///C:/Windows/System32/calc.exe'), null);
  assert.equal(safeAddress('javascript:alert(1)'), null);
  assert.equal(normalizeAction('List Tabs'), 'list_tabs');
});
