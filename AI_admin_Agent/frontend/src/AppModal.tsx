import { useEffect, useId, useState } from 'react';

type AppModalMode = 'alert' | 'confirm' | 'prompt';

type AppModalProps = {
  open: boolean;
  mode?: AppModalMode;
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  inputValue?: string;
  inputPlaceholder?: string;
  inputMaxLength?: number;
  onConfirm: (value?: string) => void;
  onCancel: () => void;
};

export function AppModal({
  open,
  mode = 'alert',
  title = '提示',
  message = '',
  confirmText = '确定',
  cancelText = '取消',
  inputValue = '',
  inputPlaceholder = '',
  inputMaxLength = 80,
  onConfirm,
  onCancel,
}: AppModalProps) {
  const titleId = useId();
  const [localInput, setLocalInput] = useState('');

  useEffect(() => {
    if (open && mode === 'prompt') setLocalInput(inputValue || '');
  }, [open, mode, inputValue]);

  useEffect(() => {
    if (!open) return;
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (mode === 'alert') onConfirm();
      else onCancel();
    };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  }, [open, mode, onConfirm, onCancel]);

  if (!open) return null;

  return (
    <div
      className="admin-modal-backdrop fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="presentation"
      onClick={() => (mode === 'alert' ? onConfirm() : onCancel())}
    >
      <div
        className="admin-modal-dialog relative w-full max-w-[22rem]"
        role="dialog"
        aria-labelledby={titleId}
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="admin-modal-header">
          <h3 id={titleId} className="admin-modal-title">
            {title}
          </h3>
        </header>
        <div className="admin-modal-body">
          {message ? <p className="admin-modal-message">{message}</p> : null}
          {mode === 'prompt' ? (
            <input
              type="text"
              value={localInput}
              maxLength={inputMaxLength}
              placeholder={inputPlaceholder}
              className="admin-modal-input"
              onChange={(e) => setLocalInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onConfirm(localInput);
                }
              }}
            />
          ) : null}
        </div>
        <footer className={`admin-modal-footer${mode === 'alert' ? ' admin-modal-footer--alert' : ''}`}>
          {mode === 'confirm' || mode === 'prompt' ? (
            <button type="button" className="admin-modal-btn-secondary" onClick={onCancel}>
              {cancelText}
            </button>
          ) : null}
          <button
            type="button"
            className="admin-modal-btn-primary"
            onClick={() => onConfirm(mode === 'prompt' ? localInput : undefined)}
          >
            {confirmText}
          </button>
        </footer>
      </div>
    </div>
  );
}
