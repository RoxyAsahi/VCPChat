/* Trimmed from packages/client/ui-theme/src/client/AppearanceRow.tsx. */
const CUBES = [
  { id: 'light', labelKey: 'appearance.light', Icon: IconLightOutline16 },
  { id: 'dark', labelKey: 'appearance.dark', Icon: IconDarkOutline16 },
  { id: 'system', labelKey: 'appearance.system', Icon: IconFollowsystemOutline16 },
]

export function AppearanceRow({ t, setTheme, useStore }) {
  const preference = useStore(state => state.preference)
  return (
    <div className={css.group}>
      <div className={css.title}>{t('appearance.title')}</div>
      <div className={css.cubeRow}>
        {CUBES.map(({ id, labelKey, Icon }) => (
          <button type="button" className={clsx(css.themeCube, preference === id && css.selected)}
            aria-pressed={preference === id} onClick={() => setTheme(id)}>
            <Icon />{t(labelKey)}
          </button>
        ))}
      </div>
    </div>
  )
}
