import { useEffect, useRef, useState } from 'react';
import { Check } from '@phosphor-icons/react';

export default function HeaderTools({ locale, onLocaleChange, t }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const outside = event => {
      if (!menuRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = event => {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return <div className="workspace-header-tools">
    <div className="header-language-menu" ref={menuRef}>
      <button ref={triggerRef} type="button" className={`header-language-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="menu" aria-expanded={open} aria-controls="language-options"
        onClick={() => setOpen(!open)} onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault(); setOpen(true);
            requestAnimationFrame(() => menuRef.current?.querySelector('[role="menuitemradio"]')?.focus());
          }
        }}>
        {t.language}
      </button>
      {open && <div id="language-options" className="header-language-options" role="menu" aria-label={t.language}>
        {[['zh', '中文'], ['en', 'English']].map(([value, label]) =>
          <button key={value} type="button" role="menuitemradio" aria-checked={locale === value}
            className={locale === value ? 'selected' : ''} onClick={() => {
              onLocaleChange(value); setOpen(false); triggerRef.current?.focus();
            }}><span>{label}</span>{locale === value && <Check size={15} weight="bold" aria-hidden="true" />}</button>)}
      </div>}
    </div>
    <button type="button" className="text-link header-resource" disabled
      title={locale === 'zh' ? '使用说明暂未开放' : 'User guide not available yet'}>{t.guide}</button>
    <button type="button" className="text-link header-resource" disabled title={t.citePending}>{t.cite}</button>
  </div>;
}
