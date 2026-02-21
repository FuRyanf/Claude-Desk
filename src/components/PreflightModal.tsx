import type { ContextPreview } from '../types';

interface PreflightModalProps {
  open: boolean;
  preview: ContextPreview | null;
  fullAccess: boolean;
  enabledSkills: string[];
  onCancel: () => void;
  onConfirm: () => void;
}

export function PreflightModal({
  open,
  preview,
  fullAccess,
  enabledSkills,
  onCancel,
  onConfirm
}: PreflightModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <section className="modal">
        <h2>Preflight Check</h2>
        <p>Review context before running Claude.</p>

        {fullAccess ? <p className="modal-error">Full Access is enabled for this thread.</p> : null}

        <div className="modal-grid">
          <div>
            <h3>Files included</h3>
            {preview && preview.files.length > 0 ? (
              <ul>
                {preview.files.map((file) => (
                  <li key={file.path}>
                    {file.path} ({file.size} B)
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No additional files included.</p>
            )}
          </div>

          <div>
            <h3>Summary</h3>
            <p>Total size: {preview?.totalSize ?? 0} B</p>
            <p>Full Access: {fullAccess ? 'Enabled' : 'Disabled'}</p>
            <p>Enabled skills: {enabledSkills.length > 0 ? enabledSkills.join(', ') : 'None'}</p>
          </div>
        </div>

        <footer className="modal-actions">
          <button type="button" className="ghost-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary-button" onClick={onConfirm}>
            Run Claude
          </button>
        </footer>
      </section>
    </div>
  );
}
