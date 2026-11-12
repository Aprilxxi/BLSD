import { ArrowClockwise, CaretDown, Play, SlidersHorizontal, UploadSimple } from '@phosphor-icons/react';
import HelpTip from './HelpTip.jsx';
import { MODEL_PARAMETER_HELP } from './modelParameterHelp.js';

/** Workspace controls use the existing import, validation and fitting handlers. */
export default function WorkspaceInput({
  t, locale, dragging, fileDrop, fileRef, onImportFiles,
  pasteOpen, onTogglePaste, csvText, onCsvTextChange, onAcceptCsv,
  onDownloadTemplate, onUseDemo, uploadError, dataIssues,
  model, onModelChange, advanced, onToggleAdvanced, basisSummary,
  modelError, fitIssues, running, canRun, onRunAnalysis, onResetData,
  hasInput, downloadControl,
}) {
  const advancedFields = [
    ['draws', t.draws, 100, 10000, 1],
    ['seed', t.seed, 0, 2147483647, 1],
    ['kAge', t.kAge, 4, hasInput ? Math.min(40, basisSummary.ages.length - 1) : 40, 1],
    ['kYear', t.kYear, 4, hasInput ? Math.min(40, basisSummary.years.length - 1) : 40, 1],
    ['threshold', t.threshold, 0.000001, 1, 'any'],
  ];

  return <aside className="workspace-controls" aria-label={t.dataTitle}>
    <section className="workspace-input-section" aria-labelledby="workspace-input-title">
      <h2 id="workspace-input-title">{t.dataTitle}</h2>
      <div className={`upload-zone csv-drop-zone${dragging ? ' dragging' : ''}`}
        onDragEnter={fileDrop.onDragEnter} onDragOver={fileDrop.onDragOver}
        onDragLeave={fileDrop.onDragLeave} onDrop={fileDrop.onDrop}>
        <UploadSimple aria-hidden="true" size={28} weight="light" />
        <h3>{dragging ? t.dropTitle : t.uploadTitle}</h3>
        <div className="action-row">
          <button type="button" className="primary" onClick={() => fileRef.current?.click()}>
            <UploadSimple aria-hidden="true" size={17} />{t.upload}
          </button>
          <button type="button" className="secondary" onClick={onTogglePaste}
            aria-expanded={pasteOpen} aria-controls="workspace-paste-section">{t.paste}</button>
        </div>
        <input ref={fileRef} aria-hidden="true" tabIndex={-1} type="file"
          accept=".csv,text/csv" aria-label={t.upload} className="file-input"
          onChange={event => { void onImportFiles(event.target.files); }} />
      </div>
      <div className="input-shortcuts">
        <button type="button" className="text-link" onClick={onDownloadTemplate}>{t.downloadTemplate}</button>
        <button type="button" className="text-link" onClick={onUseDemo}>{t.source}</button>
      </div>
      {uploadError && <p role="alert" className="error-line">{t[uploadError] || uploadError}</p>}
      {pasteOpen && <section id="workspace-paste-section" className="paste-section">
        <label htmlFor="csv-text">{t.pasteLabel}</label>
        <textarea id="csv-text" value={csvText} onChange={event => onCsvTextChange(event.target.value)}
          placeholder="Year,Age_Group,Count,Pop" spellCheck={false} />
        <button type="button" className="secondary" onClick={() => onAcceptCsv(csvText)}>{t.validate}</button>
      </section>}
      {dataIssues}
    </section>

    <section className="workspace-model-section" aria-labelledby="workspace-model-title">
      <h2 id="workspace-model-title">{t.modelTitle}</h2>
      <form className="model-form" onSubmit={onRunAnalysis}>
        <div className="form-main">
          <label htmlFor="method">{t.method}</label>
          <select id="method" value={model.method} onChange={event => onModelChange('method', event.target.value)}>
            <option value="quasi-gcv">{t.quasi}</option>
            <option value="quasi-reml">{t.quasiReml}</option>
            <option value="nb-reml">{t.nb}</option>
          </select>
          <button type="button" className="advanced-button" disabled={!hasInput} onClick={onToggleAdvanced}
            aria-expanded={advanced && hasInput} aria-controls="workspace-advanced-fields">
            <SlidersHorizontal aria-hidden="true" size={18} />{t.advanced}
            <CaretDown aria-hidden="true" className={advanced ? 'rotated' : ''} />
          </button>
          {advanced && hasInput && <div id="workspace-advanced-fields" className="advanced-fields">
            {advancedFields.map(([name, label, min, max, step]) => <div key={name}>
              <div className="parameter-label"><label htmlFor={name}>{label}</label><HelpTip key={`${name}-${locale}`} title={label} paragraphs={MODEL_PARAMETER_HELP[name][locale]} locale={locale} portal className="parameter-help" /></div>
              <input id={name} type="number" min={min} max={max} step={step}
                value={model[name]} onChange={event => onModelChange(name, event.target.value)} required />
            </div>)}
          </div>}
          {modelError && <p className="error-line" role="alert">{t.settingsError}</p>}
          {fitIssues}
          <div className="action-row">
            <button className="primary" type="submit" disabled={running || !canRun}>
              <Play aria-hidden="true" size={18} />{t[running ? 'running' : 'run']}
            </button>
            <button className="secondary" type="button" onClick={onResetData}>
              <ArrowClockwise aria-hidden="true" size={16} />{t.reset}
            </button>
          </div>
        </div>
      </form>
      <div className="workspace-download-control">{downloadControl}</div>
    </section>
  </aside>;
}
