import { useEffect, useId, useRef, useState } from 'react';
import { WarningCircle } from '@phosphor-icons/react';
import { METRIC_META } from './metricMeta.js';

export default function MetricHelp({ metric, locale }) {
  const meta = METRIC_META[metric];
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null), buttonRef = useRef(null), closeTimer = useRef(null);
  const tooltipId = useId();
  const cancelClose = () => clearTimeout(closeTimer.current);
  const show = () => { cancelClose(); setOpen(true); };
  const hideAfterLeave = () => {
    cancelClose();
    if (document.activeElement !== buttonRef.current) {
      closeTimer.current = setTimeout(() => setOpen(false), 150);
    }
  };

  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!open) return;
    const outside = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = event => {
      if (event.key === 'Escape') { cancelClose(); setOpen(false); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return <span className="metric-help" ref={rootRef} onMouseEnter={show} onMouseLeave={hideAfterLeave}
    onFocus={show} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover')) setOpen(false);
    }}>
    <button ref={buttonRef} type="button" className="metric-help-trigger"
      aria-label={locale === 'zh' ? `${meta.title.zh}说明` : `About ${meta.title.en}`}
      aria-describedby={open ? tooltipId : undefined} onClick={show}>
      <WarningCircle aria-hidden="true" size={14} />
    </button>
    {open && <span id={tooltipId} role="tooltip" className="metric-help-tooltip">
      {meta.help[locale].map(paragraph => <span className="metric-help-paragraph" key={paragraph}>{paragraph}</span>)}
    </span>}
  </span>;
}
