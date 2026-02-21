import { useEffect, useState } from 'react';

interface SettingsModalProps {
  open: boolean;
  initialCliPath: string;
  detectedCliPath?: string | null;
  onClose: () => void;
  onSave: (path: string) => void;
  onCopyEnvDiagnostics?: () => void | Promise<void>;
}

export function SettingsModal({
  open,
  initialCliPath,
  detectedCliPath,
  onClose,
  onSave,
  onCopyEnvDiagnostics
}: SettingsModalProps) {
  const [cliPath, setCliPath] = useState(initialCliPath);

  useEffect(() => {
    if (open) {
      setCliPath(initialCliPath);
    }
  }, [open, initialCliPath]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <section className="modal settings-modal">
        <h2>Settings</h2>
        <p>Configure the Claude CLI path used by Claude Desk.</p>

        <label htmlFor="cli-path">Claude CLI path</label>
        <input
          id="cli-path"
          type="text"
          placeholder="/opt/homebrew/bin/claude"
          value={cliPath}
          onChange={(event) => setCliPath(event.target.value)}
        />

        {detectedCliPath ? <p className="muted">Detected path: {detectedCliPath}</p> : null}

        <footer className="modal-actions">
          <button type="button" className="ghost-button" onClick={() => void onCopyEnvDiagnostics?.()}>
            Copy terminal env diagnostics
          </button>
          <button type="button" className="ghost-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary-button" onClick={() => onSave(cliPath.trim())}>
            Save
          </button>
        </footer>
      </section>
    </div>
  );
}
