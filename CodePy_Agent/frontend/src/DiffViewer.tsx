export default function DiffViewer(props: { diff: string; files: string[] }) {
  if (!props.diff && !props.files.length) {
    return <div className="muted pad">尚无 Diff 预览</div>
  }
  return (
    <div className="diff-viewer">
      {props.files.length ? (
        <div className="diff-files">
          {props.files.map((f) => (
            <span key={f} className="chip">
              {f}
            </span>
          ))}
        </div>
      ) : null}
      <pre className="diff-pre">{props.diff || '// empty'}</pre>
    </div>
  )
}
