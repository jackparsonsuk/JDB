import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import { sql as sqlLanguage, MSSQL, MySQL } from '@codemirror/lang-sql'
import type { DbKind } from '@shared/types'
import { useColorScheme } from '../lib/theme'

const extensions = {
  mssql: [sqlLanguage({ dialect: MSSQL }), EditorView.lineWrapping],
  mysql: [sqlLanguage({ dialect: MySQL }), EditorView.lineWrapping]
}

/** SQL shown before it runs, highlighted like the editor and wrapped, but read-only. */
export function SqlPreview({ sql, kind, className = '' }: { sql: string; kind: DbKind; className?: string }) {
  const scheme = useColorScheme()
  return (
    <div className={`sql-preview ${className}`}>
      <CodeMirror
        value={sql}
        theme={scheme}
        editable={false}
        basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false, highlightSelectionMatches: false }}
        extensions={extensions[kind]}
      />
    </div>
  )
}
