import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const previewCss = source('p2-preview.css');

// Source-level regression guard for the shared dismiss-button/card-wrapper class.
// Browser bounds, resize and native dialog interaction still need UI validation.
function declarations(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Missing CSS rule: ${selector}`);
  return Object.fromEntries(match[1].split(';').filter(value => value.trim()).map(value => {
    const colon = value.indexOf(':');
    return [value.slice(0, colon).trim(), value.slice(colon + 1).trim()];
  }));
}

test('face-only card wrapper overrides legacy dismiss positioning after board styles', () => {
  const main = source('main.tsx');
  assert.ok(main.indexOf("import './p2-preview.css'") > main.indexOf("import './board.css'"));
  const wrapper = declarations(previewCss, '.face-only-dialog > .preview-dismiss');
  assert.equal(wrapper.position, 'static');
  assert.equal(wrapper.inset, 'auto');
  assert.equal(wrapper.padding, '0');
  assert.equal(wrapper.margin, '0');
  assert.equal(wrapper.flex, 'none');
});

test('face-only preview reserves viewport gutters while preserving portrait sizing', () => {
  const modal = declarations(previewCss, 'dialog.card-inspector-overlay.face-only-dialog');
  const wrapper = declarations(previewCss, '.face-only-dialog > .preview-dismiss');
  const face = declarations(source('index.css'), '.inspector-card > .card-art-viewport');
  assert.equal(modal.padding, '16px');
  assert.equal(modal.height, '100dvh');
  assert.equal(wrapper.width, 'min(88vw,calc(86dvh * 5 / 7),480px)');
  assert.equal(wrapper['max-width'], 'min(100%,calc((100dvh - 32px) * 5 / 7))');
  assert.equal(wrapper['max-height'], '100%');
  assert.equal(wrapper.overflow, 'auto'); // Keep an image retry action reachable in short windows.
  assert.equal(face.height, 'auto');
  assert.equal(face['aspect-ratio'], '5 / 7');
});
