type Entry = { name: string; path: string; type: 'file' | 'dir'; size?: number }

export default function FileTree(props: {
  entries: Entry[]
  selected?: string
  onSelect: (path: string, type: 'file' | 'dir') => void
  loading?: boolean
}) {
  return (
    <div className="file-tree">
      {props.loading ? <div className="muted">加载中…</div> : null}
      {!props.loading && !props.entries.length ? <div className="muted">空目录</div> : null}
      <ul>
        {props.entries.map((e) => (
          <li key={e.path}>
            <button
              type="button"
              className={props.selected === e.path ? 'tree-item active' : 'tree-item'}
              onClick={() => props.onSelect(e.path, e.type)}
              title={e.path}
            >
              <span className="tree-icon">{e.type === 'dir' ? '▸' : '·'}</span>
              <span className="tree-name">{e.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
