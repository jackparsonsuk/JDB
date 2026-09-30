import type { ReactNode } from 'react'
import { closeWhatsNew, useWhatsNew } from '../lib/whatsNew'

/** A note's **bold** runs, which the changelog uses for button and menu names. */
function renderNote(note: string): ReactNode[] {
  return note.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : part
  )
}

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
                <li key={i}>{renderNote(note)}</li>
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
