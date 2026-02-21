interface FullAccessWarningModalProps {
  open: boolean;
  onCancel: () => void;
  onEnable: () => void;
}

export function FullAccessWarningModal({ open, onCancel, onEnable }: FullAccessWarningModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <section className="modal warning-modal">
        <h2>Enable Full Access Mode?</h2>
        <p>Full Access Mode allows Claude to execute without permission prompts.</p>
        <footer className="modal-actions">
          <button type="button" className="ghost-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="danger-button" onClick={onEnable}>
            Enable
          </button>
        </footer>
      </section>
    </div>
  );
}
