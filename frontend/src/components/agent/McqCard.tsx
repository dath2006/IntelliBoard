import React, { useState } from 'react';
import { HelpCircle, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export interface McqOption {
  id: string;
  label: string;
}

export interface McqData {
  question: string;
  options: McqOption[];
  multiselect?: boolean;
}

interface McqCardProps {
  messageId: string;
  mcqData: McqData;
  onSubmit: (response: string) => void;
}

export const McqCard: React.FC<McqCardProps> = ({ messageId, mcqData, onSubmit }) => {
  const { question, options, multiselect = false } = mcqData;

  const storageSelectedKey = `mcq_selected_${messageId}`;
  const storageSubmittedKey = `mcq_submitted_${messageId}`;

  // Initial state from localStorage if available
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(storageSelectedKey);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [submitted, setSubmitted] = useState<boolean>(() => {
    return localStorage.getItem(storageSubmittedKey) === 'true';
  });

  const handleToggleOption = (optionId: string) => {
    if (submitted) return;

    setSelectedIds((prev) => {
      if (multiselect) {
        if (prev.includes(optionId)) {
          return prev.filter((id) => id !== optionId);
        } else {
          return [...prev, optionId];
        }
      } else {
        return [optionId];
      }
    });
  };

  const handleSubmit = () => {
    if (selectedIds.length === 0 || submitted) return;

    // Find the labels of selected options
    const selectedLabels = options
      .filter((opt) => selectedIds.includes(opt.id))
      .map((opt) => opt.label);

    if (selectedLabels.length === 0) return;

    // Persist status
    localStorage.setItem(storageSelectedKey, JSON.stringify(selectedIds));
    localStorage.setItem(storageSubmittedKey, 'true');
    setSubmitted(true);

    // Format message and send back to agent
    const responseMessage = `I chose: ${selectedLabels.join(', ')}`;
    onSubmit(responseMessage);
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm text-sm overflow-hidden space-y-3.5">
      {/* Header */}
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <HelpCircle className="size-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-foreground leading-tight text-[13px]">{question}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {multiselect ? 'Select all that apply' : 'Select one option'}
          </p>
        </div>
        {submitted && (
          <span className="shrink-0 flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-3" />
            Submitted
          </span>
        )}
      </div>

      {/* Options List */}
      <div className="space-y-1.5 pt-1">
        {options.map((option) => {
          const isSelected = selectedIds.includes(option.id);
          return (
            <div
              key={option.id}
              onClick={() => handleToggleOption(option.id)}
              className={cn(
                'flex items-start gap-3 p-3 rounded-lg border text-xs transition-all select-none',
                submitted ? 'opacity-80' : 'cursor-pointer',
                isSelected
                  ? 'border-primary bg-primary/5 text-foreground'
                  : 'border-border/60 bg-muted/20 hover:bg-muted/40 text-muted-foreground hover:text-foreground'
              )}
            >
              {/* Custom selection icon indicator */}
              <div className="mt-0.5 shrink-0">
                {multiselect ? (
                  <div
                    className={cn(
                      'size-4 rounded border flex items-center justify-center transition-colors',
                      isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30'
                    )}
                  >
                    {isSelected && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>
                ) : (
                  <div
                    className={cn(
                      'size-4 rounded-full border flex items-center justify-center transition-colors',
                      isSelected ? 'border-primary bg-primary/10' : 'border-muted-foreground/30'
                    )}
                  >
                    {isSelected && (
                      <div className="size-2 rounded-full bg-primary" />
                    )}
                  </div>
                )}
              </div>
              <span className="font-medium flex-1 leading-snug">{option.label}</span>
            </div>
          );
        })}
      </div>

      {/* Footer / Submit Button */}
      {!submitted && (
        <div className="flex justify-end pt-1">
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={selectedIds.length === 0}
            className="h-8 px-4 text-xs font-semibold gap-1.5"
          >
            Submit Answer
          </Button>
        </div>
      )}
    </div>
  );
};
