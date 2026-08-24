/* Trimmed from packages/client/ui-settings-general/src/client/GeneralSection.tsx. */
export function GeneralSection({ renderSlot }) {
  return (
    <div className={css.section}>
      {renderSlot('settings.general.item', {})}
    </div>
  )
}
