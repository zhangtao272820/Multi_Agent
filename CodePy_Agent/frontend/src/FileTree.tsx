import { useCallback, useRef, useState } from 'react'

export type Entry = { name: string; path: string; type: 'file' | 'dir'; size?: number }

type Props = {
  entries: Entry[]
  selected?: string
  loading?: boolean
  loadChildren: (path: string) => Promise<Entry[]>
  onOpenFile: (path: string) => void
}

function sortEntries(list: Entry[]): Entry[] {
  return [...list].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}

export default function FileTree(props: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [childrenMap, setChildrenMap] = useState<Record<string, Entry[]>>({})
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({})
  const childrenRef = useRef(childrenMap)
  childrenRef.current = childrenMap
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const loadRef = useRef(props.loadChildren)
  loadRef.current = props.loadChildren

  const toggleDir = useCallback(async (path: string) => {
    if (expandedRef.current[path]) {
      setExpanded((prev) => ({ ...prev, [path]: false }))
      return
    }
    if (!childrenRef.current[path]) {
      setLoadingMap((prev) => ({ ...prev, [path]: true }))
      try {
        const kids = sortEntries(await loadRef.current(path))
        setChildrenMap((prev) => ({ ...prev, [path]: kids }))
      } finally {
        setLoadingMap((prev) => ({ ...prev, [path]: false }))
      }
    }
    setExpanded((prev) => ({ ...prev, [path]: true }))
  }, [])

  function renderNodes(nodes: Entry[], depth: number, parentPath: string) {
    const sorted = sortEntries(nodes)
    return (
      <ul className="tree-list" role="group" data-parent={parentPath || 'root'}>
        {sorted.map((e, idx) => {
          const isLast = idx === sorted.length - 1
          const isDir = e.type === 'dir'
          const isOpen = !!expanded[e.path]
          const kids = childrenMap[e.path]
          const childLoading = !!loadingMap[e.path]
          return (
            <li key={e.path} className={`tree-node ${isLast ? 'is-last' : ''}`} role="treeitem" aria-expanded={isDir ? isOpen : undefined}>
              <div className="tree-row" style={{ paddingLeft: `${10 + depth * 14}px` }}>
                {isDir ? (
                  <button
                    type="button"
                    className={`tree-twist ${isOpen ? 'open' : ''}`}
                    aria-label={isOpen ? '折叠' : '展开'}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      void toggleDir(e.path)
                    }}
                  >
                    <span className="tree-twist__chev" />
                  </button>
                ) : (
                  <span className="tree-twist tree-twist--leaf" aria-hidden="true" />
                )}
                <button
                  type="button"
                  className={`tree-item ${props.selected === e.path ? 'active' : ''} ${isDir ? 'is-dir' : 'is-file'}`}
                  onClick={() => {
                    if (isDir) void toggleDir(e.path)
                    else props.onOpenFile(e.path)
                  }}
                  title={e.path}
                >
                  <span className={`tree-glyph ${isDir ? (isOpen ? 'dir-open' : 'dir') : 'file'}`} aria-hidden="true" />
                  <span className="tree-name">{e.name}</span>
                </button>
              </div>
              {isDir && isOpen ? (
                childLoading ? (
                  <div className="tree-loading" style={{ paddingLeft: `${28 + depth * 14}px` }}>
                    加载中…
                  </div>
                ) : kids && kids.length ? (
                  renderNodes(kids, depth + 1, e.path)
                ) : (
                  <div className="tree-empty" style={{ paddingLeft: `${28 + depth * 14}px` }}>
                    空目录
                  </div>
                )
              ) : null}
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <div className="file-tree" role="tree">
      {props.loading ? <div className="muted pad">加载中…</div> : null}
      {!props.loading && !props.entries.length ? <div className="muted pad">空目录</div> : null}
      {!props.loading && props.entries.length ? renderNodes(props.entries, 0, '') : null}
    </div>
  )
}
