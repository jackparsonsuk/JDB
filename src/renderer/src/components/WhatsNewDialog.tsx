import { closeWhatsNew, useWhatsNew } from '../lib/whatsNew'

/** The release notes for the versions an update brought, or the whole changelog from the palette. */
export function WhatsNewDialog() {
  const entries = useWhatsNew()
  if (!entries) return null
  return (
    <div className="overlay" onMouseDown={closeWhatsNew}>
      <div className="dialog whats-new" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && closeWhatsNew()}>
        <h2>What's new</h2>
        {entries.map((entry) => (
          <section key={entry.version}>
            <h3>JDB {entry.version}</h3>
            <ul>
              {entry.notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          </section>
        ))}
        <div className="dialog-actions">
          <span className="grow" />
          <button className="primary" autoFocus onClick={closeWhatsNew}>Close</button>
        </div>
      </div>
    </div>
  )
}
