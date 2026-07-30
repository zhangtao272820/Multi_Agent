import Editor from '@monaco-editor/react'

export default function MonacoPane(props: {
  path: string
  value: string
  onChange: (v: string) => void
  readOnly?: boolean
}) {
  const lang = guessLang(props.path)
  return (
    <div className="monaco-wrap">
      <div className="pane-caption">{props.path || '未打开文件'}</div>
      <Editor
        height="100%"
        theme="vs-dark"
        language={lang}
        value={props.value}
        onChange={(v) => props.onChange(v ?? '')}
        options={{
          readOnly: props.readOnly,
          minimap: { enabled: false },
          fontSize: 13,
          wordWrap: 'on',
          scrollBeyondLastLine: false,
        }}
      />
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
