import { EditorView } from '@uiw/react-codemirror'
import type { Extension } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { useColorScheme, useTheme } from './theme'

/** Gruvbox dark (medium), from the original palette. */
const G = {
  bg: '#282828', bg1: '#3c3836', bg2: '#504945', fg: '#ebdbb2', fg4: '#a89984', gray: '#928374',
  red: '#fb4934', green: '#b8bb26', yellow: '#fabd2f', blue: '#83a598', purple: '#d3869b', aqua: '#8ec07c', orange: '#fe8019'
}

const gruvbox: Extension = [
  EditorView.theme({
    '&': { color: G.fg, backgroundColor: G.bg },
    '.cm-content': { caretColor: G.fg },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: G.fg },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: `${G.bg2} !important` },
    '.cm-activeLine': { backgroundColor: '#32302f' },
    '.cm-gutters': { backgroundColor: G.bg, color: G.gray, border: 'none' },
    '.cm-activeLineGutter': { backgroundColor: '#32302f', color: G.fg4 },
    '.cm-selectionMatch': { backgroundColor: '#45403d' },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: G.bg2, outline: `1px solid ${G.gray}` },
    '.cm-tooltip': { backgroundColor: G.bg1, color: G.fg, border: `1px solid ${G.bg2}` },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: G.bg2, color: G.fg },
    '.cm-completionDetail': { color: G.gray },
    '.cm-panels': { backgroundColor: G.bg1, color: G.fg },
    '.cm-searchMatch': { backgroundColor: '#665c54', outline: `1px solid ${G.yellow}` }
  }, { dark: true }),
  syntaxHighlighting(HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: G.red },
    { tag: [t.typeName, t.className, t.standard(t.name)], color: G.yellow },
    { tag: [t.string, t.special(t.string)], color: G.green },
    { tag: [t.number, t.bool, t.null, t.atom], color: G.purple },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: G.aqua },
    { tag: [t.propertyName, t.attributeName], color: G.blue },
    { tag: [t.special(t.name), t.variableName, t.labelName], color: G.fg },
    { tag: [t.comment, t.lineComment, t.blockComment], color: G.gray, fontStyle: 'italic' },
    { tag: [t.operator, t.punctuation, t.bracket], color: G.fg4 },
    { tag: t.invalid, color: G.red, textDecoration: 'underline' }
  ]))
]

/** The CodeMirror theme for the app's theme: Gruvbox gets its own colours, the rest CodeMirror's light or dark. */
export function useEditorTheme(): 'light' | 'dark' | Extension {
  const theme = useTheme()
  const scheme = useColorScheme()
  return theme === 'gruvbox' ? gruvbox : scheme
}
