import { useEffect, useState } from 'react';

interface AddWorkspaceModalProps {
  open: boolean;
  initialPath?: string;
  error?: string | null;
  saving?: boolean;
  onClose: () => void;
  onConfirm: (path: string) => void;
  onPickDirectory: () => void;
}

export function AddWorkspaceModal({
  open,
  initialPath = '',
  error,
  saving,
  onClose,
  onConfirm,
  onPickDirectory
}: AddWorkspaceModalProps) {
  const [path, setPath] = useState(initialPath);

  useEffect(() => {
    if (open) {
      setPath(initialPath);
    }
  }, [initialPath, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <section className="modal add-workspace-modal">
        <h2>Add Workspace</h2>
        <p>Pick a folder or paste an absolute path.</p>

        <div className="add-workspace-row">
          <button type="button" className="ghost-button" onClick={onPickDirectory} disabled={saving}>
            Choose Folder
          </button>
        </div>

        <label htmlFor="workspace-path">Manual path</label>
        <input
          id="workspace-path"
          type="text"
          placeholder="/Users/you/project"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onConfirm(path.trim());
            }
          }}
          autoFocus
        />

        {error ? <p className="modal-error">{error}</p> : null}

        <footer className="modal-actions">
          <button type="button" className="ghost-button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => onConfirm(path.trim())}
            disabled={saving || !path.trim()}
          >
            {saving ? 'Adding...' : 'Add Workspace'}
          </button>
        </footer>
      </section>
    </div>
  );
}
