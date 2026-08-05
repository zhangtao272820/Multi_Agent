import Editor, { type OnMount } from '@monaco-editor/react'

const THEME = 'wuqu-glass'

function ensureGlassTheme(monaco: Parameters<OnMount>[1]) {
  monaco.editor.defineTheme(THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: 'b89a78', fontStyle: 'italic' },
      { token: 'string', foreground: 'f0c878' },
      { token: 'keyword', foreground: 'f0a050' },
      { token: 'number', foreground: 'e8c8a0' },
    ],
    colors: {
      'editor.background': '#00000000',
      'editorGutter.background': '#00000000',
      'editor.lineHighlightBackground': '#e8a23a18',
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': '#d4b89888',
      'editorLineNumber.activeForeground': '#f0bc62',
      'editor.selectionBackground': '#e8a23a40',
      'editorCursor.foreground': '#f0bc62',
      'minimap.background': '#00000000',
    },
  })
}

export default function MonacoPane(props: {
  path: string
  value: string
  onChange: (v: string) => void
  readOnly?: boolean
}) {
  const lang = guessLang(props.path)

  return (
    <div className="monaco-wrap">
      <div className="pane-caption">
        <span className="pane-caption__dot" aria-hidden="true" />
        <span className="pane-caption__path">{props.path || '未打开文件'}</span>
      </div>
      <div className="monaco-glass-host">
        <Editor
          height="100%"
          theme={THEME}
          language={lang}
          value={props.value}
          path={props.path || 'untitled'}
          beforeMount={ensureGlassTheme}
          onMount={(_e, monaco) => {
            ensureGlassTheme(monaco)
            monaco.editor.setTheme(THEME)
          }}
          onChange={(v) => props.onChange(v ?? '')}
          options={{
            readOnly: props.readOnly,
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace',
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            padding: { top: 12, bottom: 12 },
            automaticLayout: true,
            overviewRulerBorder: false,
          }}
        />
      </div>
    </div>
  )
}

function guessLang(path: string): string {
  const p = path.toLowerCase()
  if (p.endsWith('.ts') || p.endsWith('.tsx')) return 'typescript'
  if (p.endsWith('.js') || p.endsWith('.jsx')) return 'javascript'
  if (p.endsWith('.py')) return 'python'
  if (p.endsWith('.json')) return 'json'
  if (p.endsWith('.md')) return 'markdown'
  if (p.endsWith('.css')) return 'css'
  if (p.endsWith('.html')) return 'html'
  if (p.endsWith('.yml') || p.endsWith('.yaml')) return 'yaml'
  return 'plaintext'
}
