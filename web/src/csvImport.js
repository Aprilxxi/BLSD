import { parseCsv } from './data.js';

const MAX_CSV_BYTES = 5 * 1024 * 1024;

/** Choosing and dropping files share validation and latest-read ownership. */
export function createCsvImporter({ onAccept, onError, resetInput }) {
  let revision = 0;
  return {
    invalidate() { revision += 1; },
    async importFiles(fileList) {
      const files = Array.from(fileList || []);
      resetInput?.();
      if (!files.length) return;
      const current = ++revision;
      if (files.length !== 1) { onError('uploadSingle'); return; }
      const file = files[0];
      if (!file.name.toLowerCase().endsWith('.csv')) { onError('uploadOnly'); return; }
      if (file.size > MAX_CSV_BYTES) { onError('uploadLimit'); return; }
      onError('');
      try {
        const text = await file.text();
        if (current !== revision) return;
        onAccept(parseCsv(text), file.name);
      } catch {
        if (current === revision) onError('readError');
      }
    },
  };
}

export function isFileDrag(transfer) {
  return Array.from(transfer?.types || []).includes('Files') ||
    Array.from(transfer?.items || []).some(item => item.kind === 'file') ||
    Boolean(transfer?.files?.length);
}

/** A nested enter counter keeps the drop target active over its children. */
export function createFileDropHandlers({ onFiles, onActive }) {
  let depth = 0;
  const reset = () => { depth = 0; onActive(false); };
  return {
    reset,
    onDragEnter(event) {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      depth += 1;
      onActive(true);
    },
    onDragOver(event) {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      if (!depth) { depth = 1; onActive(true); }
    },
    onDragLeave(event) {
      if (!depth) return;
      depth -= 1;
      if (!depth) onActive(false);
    },
    onDrop(event) {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const files = Array.from(event.dataTransfer.files || []);
      reset();
      onFiles(files);
    },
    onWindowDragOver(event) {
      if (!isFileDrag(event.dataTransfer)) return;
      if (!event.defaultPrevented) event.dataTransfer.dropEffect = 'none';
      event.preventDefault();
    },
    onWindowDrop(event) {
      if (isFileDrag(event.dataTransfer)) event.preventDefault();
      reset();
    },
  };
}
