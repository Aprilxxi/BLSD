import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { WarningCircle } from '@phosphor-icons/react';

export default function HelpTip({ title, paragraphs, locale, portal = false, className = '' }) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState(null);
  const rootRef = useRef(null), buttonRef = useRef(null), tooltipRef = useRef(null), closeTimer = useRef(null);
  const tooltipId = useId();
  const cancelClose = () => clearTimeout(closeTimer.current);
  const show = () => { cancelClose(); setOpen(true); };
  const hideAfterLeave = () => {
    cancelClose();
    if (document.activeElement !== buttonRef.current) closeTimer.current = setTimeout(() => setOpen(false), 150);
  };
  const contains = target => rootRef.current?.contains(target) || tooltipRef.current?.contains(target);

  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!contains(event.target)) setOpen(false); };
    const escape = event => { if (event.key === 'Escape') { cancelClose(); setOpen(false); } };
    const moved = event => {
      if (event.type === 'scroll' && tooltipRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    if (portal) {
      document.addEventListener('scroll', moved, true);
      window.addEventListener('resize', moved);
    }
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      document.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', moved);
    };
  }, [open, portal]);

  useLayoutEffect(() => {
    if (!open || !portal || !buttonRef.current || !tooltipRef.current) return;
    const anchor = buttonRef.current.getBoundingClientRect(), popup = tooltipRef.current.getBoundingClientRect();
    const margin = 12, gap = 6;
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - popup.width - margin));
    const top = anchor.bottom + gap + popup.height <= window.innerHeight - margin
      ? anchor.bottom + gap : Math.max(margin, anchor.top - popup.height - gap);
    setPosition({ left, top });
  }, [open, portal, title, paragraphs]);

  const tooltip = open && <span id={tooltipId} ref={tooltipRef} role="tooltip"
    className={`metric-help-tooltip${portal ? ' parameter-help-tooltip' : ''}`}
    style={portal ? { left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' } : undefined}
    onMouseEnter={cancelClose} onMouseLeave={hideAfterLeave}>
    {paragraphs.map(paragraph => <span className="metric-help-paragraph" key={paragraph}>{paragraph}</span>)}
  </span>;
  return <span className={`metric-help ${className}`.trim()} ref={rootRef}
    onMouseEnter={show} onMouseLeave={hideAfterLeave} onFocus={show}
    onBlur={event => {
      if (!contains(event.relatedTarget) && !rootRef.current?.matches(':hover') && !tooltipRef.current?.matches(':hover')) setOpen(false);
    }}>
    <button ref={buttonRef} type="button" className="metric-help-trigger"
      aria-label={locale === 'zh' ? `${title}说明` : `About ${title}`}
      aria-describedby={open ? tooltipId : undefined} onClick={show}>
      <WarningCircle aria-hidden="true" size={14} />
    </button>
    {portal && tooltip ? createPortal(tooltip, document.body) : tooltip}
  </span>;
}
