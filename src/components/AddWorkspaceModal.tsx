import { useEffect, useState } from 'react';

type AddWorkspaceMode = 'local' | 'rdev';

interface AddWorkspaceModalProps {
  open: boolean;
  initialPath?: string;
  initialRdevCommand?: string;
  initialDisplayName?: string;
  initialMode?: AddWorkspaceMode;
  error?: string | null;
  saving?: boolean;
  onClose: () => void;
  onConfirmLocal: (path: string) => void;
  onConfirmRdev: (rdevSshCommand: string, displayName: string) => void;
  onPickDirectory: () => void;
}

export function AddWorkspaceModal({
  open,
  initialPath = '',
  initialRdevCommand = '',
  initialDisplayName = '',
  initialMode = 'local',
  error,
  saving,
  onClose,
  onConfirmLocal,
  onConfirmRdev,
  onPickDirectory
}: AddWorkspaceModalProps) {
  const [mode, setMode] = useState<AddWorkspaceMode>(initialMode);
  const [path, setPath] = useState(initialPath);
  const [rdevCommand, setRdevCommand] = useState(initialRdevCommand);
  const [displayName, setDisplayName] = useState(initialDisplayName);

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setPath(initialPath);
      setRdevCommand(initialRdevCommand);
      setDisplayName(initialDisplayName);
    }
  }, [initialDisplayName, initialMode, initialPath, initialRdevCommand, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <section className="modal add-workspace-modal">
        <h2>Add Project</h2>

        <div className="add-workspace-mode-toggle" role="tablist" aria-label="Workspace type">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'local'}
            className={mode === 'local' ? 'ghost-button active' : 'ghost-button'}
            onClick={() => setMode('local')}
            disabled={saving}
          >
            Local
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'rdev'}
            className={mode === 'rdev' ? 'ghost-button active' : 'ghost-button'}
            onClick={() => setMode('rdev')}
            disabled={saving}
          >
            rdev
          </button>
        </div>

        {mode === 'local' ? (
          <>
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
                  onConfirmLocal(path.trim());
                }
              }}
              autoFocus
            />
          </>
        ) : (
          <>
            <p>Paste an rdev ssh command. Authentication will happen in the terminal session when needed.</p>
            <label htmlFor="workspace-rdev-command">rdev ssh command</label>
            <input
              id="workspace-rdev-command"
              type="text"
              placeholder="rdev ssh comms-ai-open-connect/offbeat-apple"
              value={rdevCommand}
              onChange={(event) => setRdevCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onConfirmRdev(rdevCommand.trim(), displayName.trim());
                }
              }}
              autoFocus
            />

            <label htmlFor="workspace-rdev-name">Display name (optional)</label>
            <input
              id="workspace-rdev-name"
              type="text"
              placeholder="offbeat-apple"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </>
        )}

        {error ? <p className="modal-error">{error}</p> : null}

        <footer className="modal-actions">
          <button type="button" className="ghost-button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              if (mode === 'local') {
                onConfirmLocal(path.trim());
                return;
              }
              onConfirmRdev(rdevCommand.trim(), displayName.trim());
            }}
            disabled={saving || (mode === 'local' ? !path.trim() : !rdevCommand.trim())}
          >
            {saving ? 'Adding...' : mode === 'local' ? 'Add project' : 'Add rdev project'}
          </button>
        </footer>
      </section>
    </div>
  );
}
