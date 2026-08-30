/* Trimmed from packages/client/ui-settings-general/src/client/SettingsRoot.tsx. */
function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose }) {
  const active = rows.find(row => row.id === activeId)?.id ?? rows[0]?.id
  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <nav className={css.nav}>
          <div className={css.navTitle} id={titleId}>{renderSlot('settings.header', {})}</div>
          <div className={css.navList}>
            {rows.map(row => (
              <button type="button" className={clsx(css.navCell, row.id === active && css.active)}
                aria-current={row.id === active ? 'true' : undefined}
                onClick={() => onSelect(row.id)}>
                {navIcon(row.id)}<span className={css.navLabel}>{row.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className={css.content}>
          <div className={css.header}>
            <div className={css.actions}>{renderSlot('settings.action', {})}</div>
            <button type="button" className={css.close} onClick={onClose}>
              <IconCloseOutline16 size={14} />
              <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
            </button>
          </div>
          <div className={css.options}>
            {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
          </div>
        </div>
      </div>
    </div>
  )
}

export function SettingsRoot(props) {
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState(undefined)
  const rows = props.useSections(state => state)
  return (
    <>
      <button type="button" className={clsx(css.trigger, !props.wide && css.rail)}
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        {props.renderSlot('settings.trigger', { wide: props.wide })}
      </button>
      {open && <SettingsPanel rows={rows} renderSlot={props.renderSlot}
        activeId={activeId} onSelect={setActiveId} onClose={() => setOpen(false)} />}
    </>
  )
}
