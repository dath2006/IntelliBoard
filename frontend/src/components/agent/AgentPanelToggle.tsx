import React from 'react';

interface AgentPanelToggleProps {
  open: boolean;
  onToggle: () => void;
}

export const AgentPanelToggle: React.FC<AgentPanelToggleProps> = ({ open, onToggle }) => {
  return (
    <button
      className={`agent-panel-toggle-btn${open ? ' agent-panel-toggle-btn--active' : ''}`}
      onClick={onToggle}
      title={open ? 'Hide agent panel' : 'Show agent panel'}
      aria-pressed={open}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </button>
  );
};
