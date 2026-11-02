import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { prepareUpdateState } from '../src/settings/oneClickUpdate.ts';

// Execute SettingsApp's real save methods with controllable IPC timing.
function harness() {
  const source = readFileSync(new URL('../src/settings/SettingsApp.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source.replace(/^import[\s\S]*?;\r?\n/gm, '').replace('export class SettingsApp', 'class SettingsApp').replaceAll('import.meta.url', JSON.stringify(import.meta.url)), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  let timer: (() => void) | undefined;
  const saves: { patch: Record<string, unknown>; resolve: () => void; reject: (error: Error) => void }[] = [];
  let stored: Record<string, unknown> = {};
  const save = (patch: Record<string, unknown>) => new Promise((resolve, reject) => saves.push({ patch, resolve: () => { stored = { ...stored, ...patch }; resolve(stored); }, reject }));
  const SettingsApp = vm.runInNewContext(code + '\nSettingsApp;', { URL, updateAppSettings: save, window: { setTimeout: (cb: () => void) => { timer = cb; return 1; }, clearTimeout() {} } });
  const app = Object.create(SettingsApp.prototype);
  Object.assign(app, { pendingPatch: {}, saveTimer: null, queuedSave: Promise.resolve(), requireElement: () => ({}), renderSettings() {} });
  return { app, saves, fire: () => timer!(), stored: () => stored };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('failed old settings cannot replace a newer successful change before updating', async () => {
  const h = harness();
  h.app.queueSave({ movementSpeed: 0.5 }); h.fire(); await tick();
  h.app.queueSave({ movementSpeed: 1.5 }); h.fire();
  h.saves[0].reject(new Error('temporary failure')); await tick();
  h.saves[1].resolve(); await h.app.queuedSave;
  let checkpoint = false;
  let stored = h.stored();
  await prepareUpdateState(() => h.app.pendingPatch, () => { h.app.pendingPatch = {}; }, async patch => { stored = { ...stored, ...patch }; }, async () => { checkpoint = true; });
  assert.equal(stored.movementSpeed, 1.5);
  assert.equal(checkpoint, true);
});

test('the updater save barrier waits for all issued setting changes in order', async () => {
  const h = harness();
  h.app.queueSave({ movementSpeed: 0.5 }); h.fire(); await tick();
  h.app.queueSave({ movementSpeed: 1.5 }); h.fire(); await tick();
  assert.equal(h.saves.length, 1, 'new writes must not race the active write');
  let drained = false;
  const barrier = h.app.queuedSave.then(() => { drained = true; });
  h.saves[0].resolve(); await tick();
  assert.equal(h.saves.length, 2);
  assert.equal(drained, false);
  h.saves[1].resolve(); await barrier;
  assert.equal(h.stored().movementSpeed, 1.5);
});

test('a failed write retains unrelated keys while a newer edit wins on the same key', async () => {
  const h = harness();
  h.app.queueSave({ movementSpeed: 0.5, autoWalk: false }); h.fire(); await tick();
  h.app.queueSave({ movementSpeed: 1.5 }); h.fire();
  h.saves[0].reject(new Error('temporary failure')); await tick();
  assert.equal(h.saves[1].patch.autoWalk, false);
  assert.equal(h.saves[1].patch.movementSpeed, 1.5);
  h.saves[1].resolve(); await h.app.queuedSave;
  assert.equal(Object.keys(h.app.pendingPatch).length, 0);
});
