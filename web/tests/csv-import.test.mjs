import test from 'node:test';
import assert from 'node:assert/strict';
import { createCsvImporter, createFileDropHandlers, isFileDrag } from '../src/csvImport.js';

const csv = 'Year,Age_Group,Deaths,Pop,Sex\n' + ['Male', 'Female'].flatMap(Sex =>
  Array.from({ length: 5 }, (_, y) => Array.from({ length: 5 }, (_, a) =>
    `${2000 + y},${30 + a * 5}-${34 + a * 5}years,${20 + a},100000,${Sex}`)).flat()).join('\n');
const file = (name = 'input.csv', text = async () => csv, size = 1000) => ({ name, size, text });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function transferEvent(transfer = { types: ['Files'], files: [] }) {
  return { dataTransfer: transfer, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
}

test('a file drop imports the same age-band CSV with independent sex groups', async () => {
  const accepted = [], errors = [], active = [];
  const importer = createCsvImporter({ onAccept: (data, name) => accepted.push({ data, name }), onError: code => errors.push(code) });
  let pending;
  const handlers = createFileDropHandlers({ onFiles: files => { pending = importer.importFiles(files); }, onActive: value => active.push(value) });
  const event = transferEvent({ types: ['Files'], files: [file('TEST.CSV')] });
  handlers.onDrop(event); await pending;
  assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
  assert.deepEqual(active, [false]); assert.deepEqual(errors, ['']);
  assert.equal(accepted[0].name, 'TEST.CSV');
  assert.deepEqual(accepted[0].data.errors, []);
  assert.equal(accepted[0].data.rows.length, 50);
  assert.deepEqual(accepted[0].data.groups.map(group => [group.sex, group.rows.length]), [['Male', 25], ['Female', 25]]);
  assert.equal(accepted[0].data.rows[0].Age_Group, '30–34'); assert.equal(accepted[0].data.rows[0].Age_Mid, 32.5);
});

test('nested drag enter and leave stays highlighted over upload-area children', () => {
  const active = [];
  const handlers = createFileDropHandlers({ onFiles: () => assert.fail('No drop occurred'), onActive: value => active.push(value) });
  handlers.onDragEnter(transferEvent()); handlers.onDragEnter(transferEvent());
  handlers.onDragLeave(transferEvent());
  assert.equal(active.at(-1), true);
  const over = transferEvent(); handlers.onDragOver(over);
  assert.equal(over.dataTransfer.dropEffect, 'copy'); assert.equal(over.defaultPrevented, true);
  handlers.onDragLeave(transferEvent()); assert.equal(active.at(-1), false);
  handlers.onDragLeave(transferEvent()); assert.equal(active.at(-1), false);
});

test('text drags are ignored, and files outside the target cannot navigate or import', () => {
  const handlers = createFileDropHandlers({ onFiles: () => assert.fail('Outside/text drops must not import'), onActive: () => {} });
  const text = transferEvent({ types: ['text/plain'], items: [{ kind: 'string' }], files: [] });
  handlers.onDragEnter(text); handlers.onDragOver(text); handlers.onDrop(text); handlers.onWindowDragOver(text); handlers.onWindowDrop(text);
  assert.equal(text.defaultPrevented, false); assert.equal(text.stopped, false);
  const outside = transferEvent(); handlers.onWindowDragOver(outside);
  assert.equal(outside.defaultPrevented, true); assert.equal(outside.dataTransfer.dropEffect, 'none');
  handlers.onWindowDrop(outside);
  assert.equal(isFileDrag({ items: [{ kind: 'file' }] }), true);
  assert.equal(isFileDrag({ files: [file()] }), true);
  assert.equal(isFileDrag(undefined), false);
});

test('window handling preserves the accepted drop cursor and clears canceled drags', () => {
  const active = [];
  const handlers = createFileDropHandlers({ onFiles: () => {}, onActive: value => active.push(value) });
  const event = transferEvent(); handlers.onDragEnter(event); handlers.onDragOver(event); handlers.onWindowDragOver(event);
  assert.equal(event.dataTransfer.dropEffect, 'copy');
  handlers.reset(); assert.equal(active.at(-1), false);
});

test('multiple, non-CSV and oversize files preserve data and can be selected again', async () => {
  const errors = []; let resets = 0, reads = 0;
  const text = async () => { reads += 1; return csv; };
  const importer = createCsvImporter({ onAccept: () => assert.fail('Rejected files must not replace data'), onError: code => errors.push(code), resetInput: () => resets++ });
  await importer.importFiles([file('a.csv', text), file('b.csv', text)]);
  await importer.importFiles([file('a.xlsx', text)]);
  await importer.importFiles([file('a.csv', text, 5 * 1024 * 1024 + 1)]);
  await importer.importFiles([file('a.xlsx', text)]);
  await importer.importFiles([]);
  assert.deepEqual(errors, ['uploadSingle', 'uploadOnly', 'uploadLimit', 'uploadOnly']);
  assert.equal(reads, 0); assert.equal(resets, 5);
});

test('a file list is captured before resetting the picker and a 5 MB file is accepted', async () => {
  let accepted = false;
  const files = [file('a.csv', async () => csv, 5 * 1024 * 1024)];
  const importer = createCsvImporter({ onAccept: () => { accepted = true; }, onError: () => {}, resetInput: () => { files.length = 0; } });
  await importer.importFiles(files);
  assert.equal(accepted, true);
});

test('a slower earlier file or its read error cannot overwrite a later import', async () => {
  for (const lateError of [false, true]) {
    const slow = deferred(), accepted = [], errors = [];
    const importer = createCsvImporter({ onAccept: (_, name) => accepted.push(name), onError: code => errors.push(code) });
    const first = importer.importFiles([file('old.csv', () => slow.promise)]);
    await importer.importFiles([file('new.csv')]);
    if (lateError) slow.reject(new Error('old failed')); else slow.resolve(csv);
    await first;
    assert.deepEqual(accepted, ['new.csv']); assert.ok(!errors.includes('readError'));
  }
});

test('pasted/example data and rejected later selections invalidate pending file reads', async () => {
  for (const change of ['pasteOrDemo', 'invalidFile']) {
    const slow = deferred(), errors = [];
    const importer = createCsvImporter({ onAccept: () => assert.fail('Old file cannot replace the new choice'), onError: code => errors.push(code) });
    const pending = importer.importFiles([file('old.csv', () => slow.promise)]);
    if (change === 'pasteOrDemo') importer.invalidate(); else await importer.importFiles([file('new.xlsx')]);
    slow.resolve(csv); await pending;
    assert.deepEqual(errors, change === 'pasteOrDemo' ? [''] : ['', 'uploadOnly']);
  }
});

test('read failures and invalid CSV content surface their existing actionable errors', async () => {
  const errors = [], accepted = [];
  const importer = createCsvImporter({ onAccept: data => accepted.push(data), onError: code => errors.push(code) });
  await importer.importFiles([file('broken.csv', async () => { throw new Error('read failed'); })]);
  assert.equal(errors.at(-1), 'readError');
  await importer.importFiles([file('invalid.csv', async () => 'Year,Age_Group,Deaths,Pop\n2000,30+,2,1000')]);
  assert.ok(accepted[0].errors.some(error => error.code === 'INVALID_AGE_GROUP'));
});
