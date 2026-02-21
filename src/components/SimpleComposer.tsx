interface SimpleComposerProps {
  value: string;
  disabled?: boolean;
  sending?: boolean;
  onChange: (next: string) => void;
  onSend: () => Promise<void> | void;
}

export function SimpleComposer({ value, disabled, sending, onChange, onSend }: SimpleComposerProps) {
  return (
    <div className="simple-composer" data-testid="composer">
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || sending}
        placeholder="Type and press Enter"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void onSend();
          }
        }}
      />
      <button
        type="button"
        className="primary-button"
        onClick={() => void onSend()}
        disabled={disabled || sending || !value.trim()}
      >
        {sending ? 'Sending…' : 'Send'}
      </button>
    </div>
  );
}
