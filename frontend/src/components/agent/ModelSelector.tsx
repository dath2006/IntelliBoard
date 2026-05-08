import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, Loader2, Cpu, KeyIcon, UserKey, Link2Off, Key } from 'lucide-react';
import type { ModelInfo, ProviderStatus } from '../../services/llmProviders';
import {
  disconnectGitHub,
  listModels,
  listProviders,
  pollGitHubConnect,
  startGitHubConnect,
} from '../../services/llmProviders';

// ── Shared state ──────────────────────────────────────────────────────────────

interface Props {
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}

type ConnectStep = 'idle' | 'loading' | 'show_code' | 'polling' | 'done' | 'error';

// ── Original full ModelSelector (kept for backward compat) ────────────────────

export const ModelSelector: React.FC<Props> = ({ value, onChange, disabled }) => {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [connectStep, setConnectStep] = useState<ConnectStep>('idle');
  const [deviceCode, setDeviceCode] = useState('');
  const [userCode, setUserCode] = useState('');
  const [verificationUri, setVerificationUri] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    setLoadingModels(true);
    try {
      const [m, p] = await Promise.all([listModels(), listProviders()]);
      setModels(m);
      setProviders(p);
      if (m.length > 0 && (!value || !m.find((x) => x.id === value))) {
        onChange(m[0].id);
      }
    } catch {
      // silently ignore
    } finally {
      setLoadingModels(false);
    }
  }, [value, onChange]);

  useEffect(() => {
    void refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2500);
    } catch {
      /* ignore */
    }
  };

  const handleGitHubConnect = async () => {
    setConnectStep('loading');
    setConnectError(null);
    setCodeCopied(false);
    try {
      const info = await startGitHubConnect();
      setDeviceCode(info.device_code);
      setUserCode(info.user_code);
      setVerificationUri(info.verification_uri);
      setConnectStep('show_code');
      await copyCode(info.user_code);
      window.open(info.verification_uri, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Failed to start GitHub connect');
      setConnectStep('error');
    }
  };

  const handleStartPolling = () => {
    setConnectStep('polling');
    pollRef.current = setInterval(async () => {
      try {
        const result = await pollGitHubConnect(deviceCode);
        if (result.status === 'authorized') {
          stopPolling();
          setConnectStep('done');
          await refresh();
        } else if (result.status === 'expired' || result.status === 'denied') {
          stopPolling();
          setConnectError(
            result.status === 'expired'
              ? 'Code expired. Please try again.'
              : 'Authorization was denied.',
          );
          setConnectStep('error');
        } else if (result.status === 'error') {
          stopPolling();
          setConnectError(result.message ?? 'Unknown error');
          setConnectStep('error');
        }
      } catch {
        /* keep polling */
      }
    }, 5000);
  };

  const handleDisconnectGitHub = async () => {
    try {
      await disconnectGitHub();
      await refresh();
    } catch {
      /* ignore */
    }
  };

  const handleCancelConnect = () => {
    stopPolling();
    setConnectStep('idle');
    setConnectError(null);
  };

  useEffect(() => () => stopPolling(), []);

  const githubProvider = providers.find((p) => p.id === 'github');
  const openaiProvider = providers.find((p) => p.id === 'openai');
  const openaiModels = models.filter((m) => m.provider === 'openai');
  const githubModels = models.filter((m) => m.provider === 'github');

  return (
    <div className="model-selector">
      <div className="model-selector__row">
        <select
          className="model-selector__select"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled || loadingModels || models.length === 0}
        >
          {models.length === 0 && (
            <option value="">{loadingModels ? 'Loading…' : 'No models available'}</option>
          )}
          {openaiModels.length > 0 && (
            <optgroup label="OpenAI">
              {openaiModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          )}
          {githubModels.length > 0 && (
            <optgroup label="GitHub Copilot">
              {githubModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          )}
        </select>

        <div className="model-selector__providers">
          {openaiProvider && (
            <span
              className={`model-selector__badge ${openaiProvider.connected ? 'model-selector__badge--connected' : 'model-selector__badge--disconnected'}`}
              title={
                openaiProvider.connected ? 'OpenAI connected' : 'OpenAI API key not configured'
              }
            >
              OpenAI
            </span>
          )}
          {githubProvider && (
            <span
              className={`model-selector__badge ${githubProvider.connected ? 'model-selector__badge--connected' : 'model-selector__badge--disconnected'}`}
              title={
                githubProvider.connected
                  ? 'GitHub Copilot connected'
                  : 'GitHub Copilot not connected'
              }
            >
              Copilot
            </span>
          )}
        </div>
      </div>

      {githubProvider && !githubProvider.connected && connectStep === 'idle' && (
        <button
          className="model-selector__connect-btn"
          onClick={handleGitHubConnect}
          disabled={disabled}
        >
          Connect GitHub Copilot
        </button>
      )}
      {githubProvider && githubProvider.connected && (
        <button
          className="model-selector__disconnect-btn"
          onClick={handleDisconnectGitHub}
          disabled={disabled}
        >
          Disconnect GitHub Copilot
        </button>
      )}
      {connectStep === 'loading' && (
        <div className="model-selector__connect-flow">Starting GitHub authorization…</div>
      )}
      {connectStep === 'show_code' && (
        <div className="model-selector__connect-flow">
          <div className="model-selector__connect-instructions">
            <span>Enter this code at </span>
            <a href={verificationUri} target="_blank" rel="noopener noreferrer">
              {verificationUri}
            </a>
          </div>
          <div className="model-selector__code-row">
            <div className="model-selector__user-code">{userCode}</div>
            <button
              className={`model-selector__copy-btn ${codeCopied ? 'model-selector__copy-btn--copied' : ''}`}
              onClick={() => void copyCode(userCode)}
            >
              {codeCopied ? '✓ Copied' : 'Copy'}
            </button>
          </div>
          <div className="model-selector__connect-actions">
            <button className="model-selector__connect-btn" onClick={handleStartPolling}>
              I've authorized — continue
            </button>
            <button className="model-selector__cancel-btn" onClick={handleCancelConnect}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {connectStep === 'polling' && (
        <div className="model-selector__connect-flow">
          Waiting for GitHub authorization
          <span className="model-selector__spinner" />
          <button className="model-selector__cancel-btn" onClick={handleCancelConnect}>
            Cancel
          </button>
        </div>
      )}
      {connectStep === 'done' && (
        <div className="model-selector__connect-flow model-selector__connect-flow--success">
          GitHub Copilot connected.
        </div>
      )}
      {connectStep === 'error' && (
        <div className="model-selector__connect-flow model-selector__connect-flow--error">
          {connectError}
          <button className="model-selector__cancel-btn" onClick={handleCancelConnect}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
};

// ── Compact Model Selector (for AgUiPanel footer) ─────────────────────────────

interface CompactProps {
  value: string;
  onChange: (modelId: string) => void;
  open: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export const CompactModelSelector: React.FC<CompactProps> = ({
  value,
  onChange,
  open,
  onToggle,
  disabled,
}) => {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [connectStep, setConnectStep] = useState<ConnectStep>('idle');
  const [deviceCode, setDeviceCode] = useState('');
  const [userCode, setUserCode] = useState('');
  const [verificationUri, setVerificationUri] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setLoadingModels(true);
    try {
      const [m, p] = await Promise.all([listModels(), listProviders()]);
      setModels(m);
      setProviders(p);
      if (m.length > 0 && (!value || !m.find((x) => x.id === value))) {
        onChange(m[0].id);
      }
    } catch {
      /* ignore */
    } finally {
      setLoadingModels(false);
    }
  }, [value, onChange]);

  useEffect(() => {
    void refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onToggle();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onToggle]);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };
  useEffect(() => () => stopPolling(), []);

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2500);
    } catch {
      /* ignore */
    }
  };

  const handleGitHubConnect = async () => {
    setConnectStep('loading');
    setConnectError(null);
    try {
      const info = await startGitHubConnect();
      setDeviceCode(info.device_code);
      setUserCode(info.user_code);
      setVerificationUri(info.verification_uri);
      setConnectStep('show_code');
      await copyCode(info.user_code);
      window.open(info.verification_uri, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Failed');
      setConnectStep('error');
    }
  };

  const handleStartPolling = () => {
    setConnectStep('polling');
    pollRef.current = setInterval(async () => {
      try {
        const result = await pollGitHubConnect(deviceCode);
        if (result.status === 'authorized') {
          stopPolling();
          setConnectStep('done');
          await refresh();
          onToggle();
        } else if (
          result.status === 'expired' ||
          result.status === 'denied' ||
          result.status === 'error'
        ) {
          stopPolling();
          setConnectError(result.message ?? 'Auth failed');
          setConnectStep('error');
        }
      } catch {
        /* keep polling */
      }
    }, 5000);
  };

  const handleDisconnectGitHub = async () => {
    try {
      await disconnectGitHub();
      await refresh();
    } catch {
      /* ignore */
    }
  };

  const activeModel = models.find((m) => m.id === value);
  const modelLabel = activeModel?.label ?? (loadingModels ? 'Loading…' : 'Select model');

  const githubProvider = providers.find((p) => p.id === 'github');
  const openaiProvider = providers.find((p) => p.id === 'openai');
  const openaiModels = models.filter((m) => m.provider === 'openai');
  const githubModels = models.filter((m) => m.provider === 'github');

  return (
    <div className="cmp-model" ref={dropdownRef}>
      {/* Pill trigger */}
      <button
        type="button"
        className={`cmp-model__pill ${open ? 'is-open' : ''}`}
        onClick={onToggle}
        disabled={disabled || loadingModels}
        title="Select model"
      >
        <Cpu size={11} />
        <span className="cmp-model__label">{modelLabel}</span>
        <ChevronDown size={10} className={`cmp-model__caret ${open ? 'is-up' : ''}`} />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="cmp-model__dropdown">
          <div className="cmp-model__section-header">Models</div>

          {/* Provider status row */}
          <div className="cmp-model__providers">
            {openaiProvider && (
              <span
                className={`cmp-model__provider-badge ${openaiProvider.connected ? 'is-connected' : ''}`}
                title={openaiProvider.connected ? 'Connected' : 'No API key'}
              >
                <Key size={9} />
                OpenAI
                {openaiProvider.connected ? <Check size={9} /> : null}
              </span>
            )}
            {githubProvider && (
              <span
                className={`cmp-model__provider-badge ${githubProvider.connected ? 'is-connected' : ''}`}
                title={githubProvider.connected ? 'GitHub Copilot connected' : 'Not connected'}
              >
                <UserKey size={9} />
                Copilot
                {githubProvider.connected ? <Check size={9} /> : null}
              </span>
            )}
          </div>

          {/* Model list */}
          {openaiModels.length > 0 && (
            <>
              <div className="cmp-model__group-label">OpenAI</div>
              {openaiModels.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`cmp-model__option ${m.id === value ? 'is-selected' : ''}`}
                  onClick={() => {
                    onChange(m.id);
                    onToggle();
                  }}
                >
                  {m.id === value && <Check size={11} />}
                  <span>{m.label}</span>
                </button>
              ))}
            </>
          )}
          {githubModels.length > 0 && (
            <>
              <div className="cmp-model__group-label">GitHub Copilot</div>
              {githubModels.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`cmp-model__option ${m.id === value ? 'is-selected' : ''}`}
                  onClick={() => {
                    onChange(m.id);
                    onToggle();
                  }}
                >
                  {m.id === value && <Check size={11} />}
                  <span>{m.label}</span>
                </button>
              ))}
            </>
          )}

          {/* GitHub connect/disconnect */}
          <div className="cmp-model__divider" />
          {githubProvider && !githubProvider.connected && connectStep === 'idle' && (
            <button type="button" className="cmp-model__action-btn" onClick={handleGitHubConnect}>
              <UserKey size={11} />
              Connect GitHub Copilot
            </button>
          )}
          {githubProvider && githubProvider.connected && (
            <button
              type="button"
              className="cmp-model__action-btn cmp-model__action-btn--danger"
              onClick={handleDisconnectGitHub}
            >
              <Link2Off size={11} />
              Disconnect Copilot
            </button>
          )}

          {/* Device flow states */}
          {connectStep === 'loading' && (
            <div className="cmp-model__flow-msg">
              <Loader2 size={12} className="spin" /> Starting GitHub auth…
            </div>
          )}
          {connectStep === 'show_code' && (
            <div className="cmp-model__flow-code">
              <p>
                Go to{' '}
                <a href={verificationUri} target="_blank" rel="noopener noreferrer">
                  {verificationUri}
                </a>{' '}
                and enter:
              </p>
              <div className="cmp-model__code-block">
                <span>{userCode}</span>
                <button onClick={() => void copyCode(userCode)} className="cmp-model__copy-btn">
                  {codeCopied ? <Check size={11} /> : 'Copy'}
                </button>
              </div>
              <div className="cmp-model__flow-actions">
                <button className="cmp-model__action-btn" onClick={handleStartPolling}>
                  Authorized ✓
                </button>
                <button
                  className="cmp-model__action-btn cmp-model__action-btn--ghost"
                  onClick={() => setConnectStep('idle')}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {connectStep === 'polling' && (
            <div className="cmp-model__flow-msg">
              <Loader2 size={12} className="spin" /> Waiting for authorization…
              <button
                className="cmp-model__action-btn cmp-model__action-btn--ghost"
                onClick={() => {
                  stopPolling();
                  setConnectStep('idle');
                }}
              >
                Cancel
              </button>
            </div>
          )}
          {connectStep === 'done' && (
            <div className="cmp-model__flow-msg cmp-model__flow-msg--success">
              <Check size={12} /> Connected!
            </div>
          )}
          {connectStep === 'error' && (
            <div className="cmp-model__flow-msg cmp-model__flow-msg--error">
              {connectError}
              <button
                className="cmp-model__action-btn cmp-model__action-btn--ghost"
                onClick={() => setConnectStep('idle')}
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
