import { useEffect, useMemo, useState } from 'react';

import type { ContextPack, SkillInfo } from '../types';

export interface SlashPaletteItem {
  id: string;
  group: 'Commands' | 'Skills';
  command: string;
  label: string;
  description: string;
}

interface ComposerProps {
  value: string;
  disabled?: boolean;
  contextPack: ContextPack;
  enabledSkills: SkillInfo[];
  slashItems: SlashPaletteItem[];
  onChange: (next: string) => void;
  onSubmit: (message: string) => Promise<boolean | void> | boolean | void;
  onSlashCommand: (command: string) => void;
  onContextPackChange: (next: ContextPack) => void;
  onRemoveSkill: (skillId: string) => void;
}

const contextPacks: ContextPack[] = ['Minimal', 'Git Diff', 'Debug'];

export function Composer({
  value,
  disabled,
  contextPack,
  enabledSkills,
  slashItems,
  onChange,
  onSubmit,
  onSlashCommand,
  onContextPackChange,
  onRemoveSkill
}: ComposerProps) {
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const slashMatch = useMemo(() => value.match(/(?:^|\s)\/([^\s]*)$/), [value]);
  const slashOpen = Boolean(slashMatch);
  const slashQuery = (slashMatch?.[1] ?? '').toLowerCase();

  const filteredSlashItems = useMemo(() => {
    const query = slashQuery.trim();
    if (!query) {
      return slashItems;
    }

    return slashItems.filter((item) => {
      const haystack = `${item.label} ${item.command} ${item.description}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [slashItems, slashQuery]);

  const slashVisible = slashOpen && !slashDismissed && filteredSlashItems.length > 0;

  useEffect(() => {
    setSlashIndex(0);
    setSlashDismissed(false);
  }, [value]);

  const clearSlashToken = () => {
    onChange(value.replace(/(?:^|\s)\/[^\s]*$/, '').trimEnd());
  };

  const send = async () => {
    if (isSubmitting) {
      return;
    }

    const text = value.trim();
    if (!text) {
      return;
    }

    if (text.startsWith('/')) {
      onSlashCommand(text);
      onChange('');
      return;
    }

    setIsSubmitting(true);
    try {
      const shouldClear = await onSubmit(text);
      if (shouldClear !== false) {
        onChange('');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  let lastGroup = '';

  return (
    <div className="composer-wrap" data-testid="composer">
      {slashVisible ? (
        <div className="slash-palette" role="listbox" aria-label="Slash command palette" data-testid="slash-palette">
          {filteredSlashItems.map((item, index) => {
            const showGroup = item.group !== lastGroup;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {showGroup ? <p className="slash-group">{item.group}</p> : null}
                <button
                  type="button"
                  className={index === slashIndex ? 'active' : ''}
                  onMouseEnter={() => setSlashIndex(index)}
                  onClick={() => {
                    onSlashCommand(item.command);
                    clearSlashToken();
                  }}
                >
                  <span>{item.label}</span>
                  <small>{item.description}</small>
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="composer-meta-row">
        <select value={contextPack} onChange={(event) => onContextPackChange(event.target.value as ContextPack)}>
          {contextPacks.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>

        <div className="skill-chips" aria-label="Enabled skills">
          {enabledSkills.length === 0 ? <span className="muted">No skills enabled</span> : null}
          {enabledSkills.map((skill) => (
            <button
              type="button"
              key={skill.id}
              className="skill-chip"
              onClick={() => onRemoveSkill(skill.id)}
              title="Disable skill"
            >
              {skill.name} ×
            </button>
          ))}
        </div>
      </div>

      <div className="composer-row">
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Ask Claude Desk"
          disabled={disabled}
          onKeyDown={(event) => {
            if (slashVisible) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSlashIndex((current) => (current + 1) % filteredSlashItems.length);
                return;
              }

              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSlashIndex((current) => (current - 1 + filteredSlashItems.length) % filteredSlashItems.length);
                return;
              }

              if (event.key === 'Escape') {
                event.preventDefault();
                setSlashDismissed(true);
                return;
              }

              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                const selected = filteredSlashItems[slashIndex];
                if (selected) {
                  onSlashCommand(selected.command);
                  clearSlashToken();
                }
                return;
              }
            }

            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />

        <button
          type="button"
          onClick={() => void send()}
          disabled={disabled || isSubmitting || !value.trim()}
          className="primary-button"
        >
          {isSubmitting ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
