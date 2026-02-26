import { useEffect, useState } from 'react';

type AddWorkspaceMode = 'local' | 'rdev' | 'ssh';

interface AddWorkspaceModalProps {
  open: boolean;
  initialPath?: string;
  initialRdevCommand?: string;
  initialSshCommand?: string;
  initialSshRemotePath?: string;
  initialDisplayName?: string;
  initialMode?: AddWorkspaceMode;
  error?: string | null;
  saving?: boolean;
  onClose: () => void;
  onConfirmLocal: (path: string) => void;
  onConfirmRdev: (rdevSshCommand: string, displayName: string) => void;
  onConfirmSsh: (sshCommand: string, displayName: string, remotePath: string) => void;
  onPickDirectory: () => void;
}

export function AddWorkspaceModal({
  open,
  initialPath = '',
  initialRdevCommand = '',
  initialSshCommand = '',
  initialSshRemotePath = '',
  initialDisplayName = '',
  initialMode = 'local',
  error,
  saving,
  onClose,
  onConfirmLocal,
  onConfirmRdev,
  onConfirmSsh,
  onPickDirectory
}: AddWorkspaceModalProps) {
  const [mode, setMode] = useState<AddWorkspaceMode>(initialMode);
  const [path, setPath] = useState(initialPath);
  const [rdevCommand, setRdevCommand] = useState(initialRdevCommand);
  const [sshCommand, setSshCommand] = useState(initialSshCommand);
  const [sshRemotePath, setSshRemotePath] = useState(initialSshRemotePath);
  const [displayName, setDisplayName] = useState(initialDisplayName);

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setPath(initialPath);
      setRdevCommand(initialRdevCommand);
      setSshCommand(initialSshCommand);
      setSshRemotePath(initialSshRemotePath);
      setDisplayName(initialDisplayName);
    }
  }, [
    initialDisplayName,
    initialMode,
    initialPath,
    initialRdevCommand,
    initialSshCommand,
    initialSshRemotePath,
    open
  ]);

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
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'ssh'}
            className={mode === 'ssh' ? 'ghost-button active' : 'ghost-button'}
            onClick={() => setMode('ssh')}
            disabled={saving}
          >
            ssh
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
        ) : mode === 'rdev' ? (
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
        ) : (
          <>
            <p>Paste an ssh command. Authentication will happen in the terminal session when needed.</p>
            <label htmlFor="workspace-ssh-command">ssh command</label>
            <input
              id="workspace-ssh-command"
              type="text"
              placeholder="ssh user@host"
              value={sshCommand}
              onChange={(event) => setSshCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onConfirmSsh(sshCommand.trim(), displayName.trim(), sshRemotePath.trim());
                }
              }}
              autoFocus
            />

            <label htmlFor="workspace-ssh-name">Display name (optional)</label>
            <input
              id="workspace-ssh-name"
              type="text"
              placeholder="remote-host"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />

            <label htmlFor="workspace-ssh-remote-path">Remote path (optional)</label>
            <input
              id="workspace-ssh-remote-path"
              type="text"
              placeholder="~/projects/my-repo"
              value={sshRemotePath}
              onChange={(event) => setSshRemotePath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onConfirmSsh(sshCommand.trim(), displayName.trim(), sshRemotePath.trim());
                }
              }}
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
              if (mode === 'rdev') {
                onConfirmRdev(rdevCommand.trim(), displayName.trim());
                return;
              }
              onConfirmSsh(sshCommand.trim(), displayName.trim(), sshRemotePath.trim());
            }}
            disabled={
              saving ||
              (mode === 'local' ? !path.trim() : mode === 'rdev' ? !rdevCommand.trim() : !sshCommand.trim())
            }
          >
            {saving ? 'Adding...' : mode === 'local' ? 'Add project' : mode === 'rdev' ? 'Add rdev project' : 'Add ssh project'}
          </button>
        </footer>
      </section>
    </div>
  );
}
