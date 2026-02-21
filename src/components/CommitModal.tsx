import type { GitDiffSummary } from '../types';

interface CommitModalProps {
  open: boolean;
  summary: GitDiffSummary | null;
  generatedMessage: string;
  loadingMessage: boolean;
  onClose: () => void;
  onGenerateMessage: () => void;
}

export function CommitModal({
  open,
  summary,
  generatedMessage,
  loadingMessage,
  onClose,
  onGenerateMessage
}: CommitModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <section className="modal commit-modal">
        <h2>Commit Assistant</h2>
        <p>Review current diff and optionally generate a commit message.</p>

        <h3>Diff Summary</h3>
        <pre>{summary?.stat || 'No local changes found.'}</pre>

        <h3>Diff Excerpt</h3>
        <pre>{summary?.diffExcerpt || 'No diff output.'}</pre>

        <h3>Suggested Message</h3>
        <pre>{generatedMessage || 'Not generated yet.'}</pre>

        <footer className="modal-actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            Close
          </button>
          <button type="button" className="primary-button" onClick={onGenerateMessage} disabled={loadingMessage}>
            {loadingMessage ? 'Generating…' : 'Generate message'}
          </button>
        </footer>
      </section>
    </div>
  );
}
