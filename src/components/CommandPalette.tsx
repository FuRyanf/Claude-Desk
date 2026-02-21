import { useEffect, useMemo, useState } from 'react';

export interface CommandPaletteItem {
  id: string;
  title: string;
  subtitle: string;
  group: string;
  keywords?: string[];
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  items: CommandPaletteItem[];
  onClose: () => void;
}

export function CommandPalette({ open, items, onClose }: CommandPaletteProps) {
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return items;
    }

    return items.filter((item) => {
      const haystack = [item.title, item.subtitle, item.group, ...(item.keywords ?? [])].join(' ').toLowerCase();
      return haystack.includes(normalized);
    });
  }, [items, query]);

  useEffect(() => {
    if (open) {
      setIndex(0);
      setQuery('');
    }
  }, [open]);

  useEffect(() => {
    if (index >= filtered.length) {
      setIndex(0);
    }
  }, [filtered.length, index]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (filtered.length === 0) {
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setIndex((current) => (current + 1) % filtered.length);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setIndex((current) => (current - 1 + filtered.length) % filtered.length);
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        const item = filtered[index];
        if (item) {
          item.action();
          onClose();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [filtered, index, onClose, open]);

  if (!open) {
    return null;
  }

  let lastGroup = '';

  return (
    <div className="modal-backdrop">
      <section className="modal palette-modal">
        <h2>Command Palette</h2>
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search commands"
          className="palette-search"
        />
        <div className="palette-items">
          {filtered.length === 0 ? <p className="muted">No matching commands.</p> : null}
          {filtered.map((item, itemIndex) => {
            const showGroup = item.group !== lastGroup;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {showGroup ? <p className="palette-group">{item.group}</p> : null}
                <button
                  type="button"
                  className={itemIndex === index ? 'active' : ''}
                  onMouseEnter={() => setIndex(itemIndex)}
                  onClick={() => {
                    item.action();
                    onClose();
                  }}
                >
                  <span>{item.title}</span>
                  <small>{item.subtitle}</small>
                </button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
