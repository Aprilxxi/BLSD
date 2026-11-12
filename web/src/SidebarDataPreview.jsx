import { useLayoutEffect, useRef, useState } from 'react';

const HEADINGS = {
  zh: { Year: '时期', Age_Group: '年龄段', Age_Mid: '年龄中点', Deaths: '计数', Count: '计数', Pop: '人口', Sex: '性别' },
  en: { Year: 'Period', Age_Group: 'Age group', Age_Mid: 'Age midpoint', Deaths: 'Count', Count: 'Count', Pop: 'Population', Sex: 'Sex' },
};

export function previewColumnHeading(column, locale) {
  return (HEADINGS[locale] || HEADINGS.en)[column] || column;
}

function displayCell(value, column, locale, sexLabel, groupLabels) {
  if (typeof value === 'number') {
    return column === 'Year' ? String(value) : value.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 8 });
  }
  if (column === 'Sex' && typeof sexLabel === 'function') return sexLabel(value, locale, groupLabels);
  return value ?? '';
}

/** Show original input rows only; the full table uses the existing preview dialog. */
export default function SidebarDataPreview({ rows = [], columns = [], locale, t, onViewAll, sexLabel, groupLabels = [], layoutKey }) {
  const sectionRef = useRef(null);
  const tableRef = useRef(null);
  const [tableHeight, setTableHeight] = useState(null);
  const headings = HEADINGS[locale] || HEADINGS.en;
  const title = t?.preview || (locale === 'zh' ? '数据预览' : 'Data preview');
  const viewAll = t?.viewAll || (locale === 'zh' ? '查看全部' : 'View all');

  useLayoutEffect(() => {
    if (!sectionRef.current) return undefined;
    const sidebar = sectionRef.current.closest('.workspace-sidebar');
    const results = sidebar?.parentElement.querySelector('.workspace-results');
    if (!results) return undefined;
    let animationFrame;
    const measure = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        if (!window.matchMedia('(min-width: 901px)').matches) {
          setTableHeight(null);
          return;
        }
        if (!rows.length) {
          setTableHeight(null);
          return;
        }
        const table = tableRef.current;
        if (!table) return;
        // Both columns share a bounded desktop height. Subtract the original
        // content position (including scrollTop) so scrolling the controls cannot
        // feed back into the preview height. Expanded controls remain accessible
        // in the sidebar's own scroll area if the preview reaches its minimum.
        const fitSummary = sidebar.querySelector('.sidebar-fit-summary');
        const summarySpace = fitSummary ? fitSummary.getBoundingClientRect().height + parseFloat(getComputedStyle(fitSummary).marginTop || 0) : 0;
        const bottomPadding = parseFloat(getComputedStyle(sidebar).paddingBottom || 0);
        const contentTop = table.getBoundingClientRect().top - sidebar.getBoundingClientRect().top + sidebar.scrollTop;
        const available = sidebar.clientHeight - contentTop - summarySpace - bottomPadding;
        setTableHeight(Math.max(50, Math.round(available)));
      });
    };
    const observer = new ResizeObserver(measure);
    [results, sidebar, sidebar.querySelector('.workspace-controls'), sidebar.querySelector('.sidebar-fit-summary')].filter(Boolean).forEach(element => observer.observe(element));
    window.addEventListener('resize', measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); cancelAnimationFrame(animationFrame); };
  }, [rows, locale, layoutKey]);

  if (!rows.length) return <section ref={sectionRef} className="sidebar-data-preview sidebar-data-preview--empty" aria-label={title}>
    <h2>{title}</h2>
    <p className="sidebar-preview-empty">{locale === 'zh' ? '请添加数据' : 'Add data to get started'}</p>
  </section>;

  return <section ref={sectionRef} className="sidebar-data-preview" aria-label={title}>
    <details className="sidebar-preview-disclosure" open>
      <summary><h2>{title}</h2></summary>
      <div ref={tableRef} className="sidebar-preview-table-scroll" style={tableHeight === null ? undefined : { height: tableHeight }}>
        <table aria-label={title}>
          <thead><tr>{columns.map(column => <th key={column} scope="col">{headings[column] || column}</th>)}</tr></thead>
          <tbody>{rows.slice(0, 1000).map((row, index) => <tr key={index}>
            {columns.map(column => <td key={column}>{displayCell(row[column], column, locale, sexLabel, groupLabels)}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
    </details>
    <button className="text-link sidebar-preview-view-all" type="button" onClick={onViewAll}>{viewAll}</button>
  </section>;
}

