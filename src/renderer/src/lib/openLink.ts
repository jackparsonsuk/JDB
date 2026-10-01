import { useCallback, useSyncExternalStore, type DragEvent, type MouseEvent } from 'react'
import { otherPane, type PaneId } from '@shared/panes'
import { useAppState, type OpenTarget } from '../state'

/**
 * References (FK jumps, cross-database links, explorer cards) open on click and can be dragged
 * onto a pane. Shift+click opens in the other pane. Tabs use the same drag channel to move.
 */

const DRAG_TYPE = 'application/x-jdb'

export type DragPayload = { kind: 'open'; target: OpenTarget } | { kind: 'tab'; tabId: string }

// A tiny store so the workspace can show drop zones while a JDB drag is in flight. Drop targets
// read the payload from here, since dataTransfer contents are hidden until the drop itself.
let dragging: DragPayload | null = null
const listeners = new Set<() => void>()
function setDragging(next: DragPayload | null): void {
  if (dragging === next) return
  dragging = next
  listeners.forEach((l) => l())
}
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The JDB drag in progress, if any. */
export function useDragging(): DragPayload | null {
  return useSyncExternalStore(subscribe, () => dragging)
}

// The source element can unmount mid-drag (the grid virtualises rows), so clear on any drag end.
// Deferred so drop handlers can still read the payload.
const clearSoon = (): void => void setTimeout(() => setDragging(null), 0)
window.addEventListener('dragend', clearSoon, true)
window.addEventListener('drop', clearSoon, true)

export function startDrag(event: DragEvent, payload: DragPayload, label: string): void {
  event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload))
  event.dataTransfer.effectAllowed = 'copyMove'
  setDragImage(event, label)
  // Chromium ends the drag at once if the DOM under the pointer changes during dragstart.
  setTimeout(() => setDragging(payload), 0)
}

/** A small pill naming what's being dragged, instead of a snapshot of a tiny ↗ button. */
function setDragImage(event: DragEvent, label: string): void {
  const ghost = document.createElement('div')
  ghost.className = 'drag-ghost'
  ghost.textContent = label
  document.body.appendChild(ghost)
  event.dataTransfer.setDragImage(ghost, -10, -10)
  setTimeout(() => ghost.remove(), 0)
}

export function targetLabel(target: OpenTarget): string {
  if (target.kind === 'design') return `${target.table.name} design`
  if (target.kind === 'routine') return target.routine.name
  if (target.kind === 'search') return `Find ${target.value}`
  const where = target.kind === 'table' ? target.filters : target.key
  const values = where.map((f) => f.value).filter((v) => v !== undefined).join(' · ')
  return values ? `${target.table.name} ${values}` : target.table.name
}

/** The pane an element sits in, from the data-pane attribute on its tab pane. */
export function paneOf(element: Element): PaneId | undefined {
  const value = element.closest('[data-pane]')?.getAttribute('data-pane')
  return value === '0' || value === '1' ? Number(value) as PaneId : undefined
}

export interface LinkProps {
  draggable: true
  onClick(event: MouseEvent): void
  onDragStart(event: DragEvent): void
}

/** Props that make an element open `target` on click (Shift: other pane) and drag onto a pane. */
export function useOpenLink(): (target: OpenTarget) => LinkProps {
  const { open } = useAppState()
  return useCallback((target: OpenTarget) => ({
    draggable: true,
    onClick: (event: MouseEvent) => {
      const here = paneOf(event.currentTarget)
      open(target, event.shiftKey && here !== undefined ? otherPane(here) : here)
    },
    onDragStart: (event: DragEvent) => {
      event.stopPropagation()
      startDrag(event, { kind: 'open', target }, targetLabel(target))
    }
  }), [open])
}
