import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelInfo, ProviderStatus } from '../../services/llmProviders';
import {
  disconnectGitHub,
  listModels,
  listProviders,
  pollGitHubConnect,
  startGitHubConnect,
} from '../../services/llmProviders';

interface Props {
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}

type ConnectStep = 'idle' | 'loading' | 'show_code' | 'polling' | 'done' | 'error';

export const ModelSelector: React.FC<Props> = ({ value, onChange, disabled }) => {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  // GitHub connect flow state
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
      // Auto-select first model if current value is empty or no longer valid
      if (m.length > 0 && (!value || !m.find((x) => x.id === value))) {
        onChange(m[0].id);
      }
    } catch {
      // silently ignore — user may not be logged in yet
    } finally {
      setLoadingModels(false);
    }
  }, [value, onChange]);

  useEffect(() => {
    void refresh();
  }, []);

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
      // clipboard not available — silently ignore
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
      // Auto-copy the user code so it's ready to paste on GitHub
      await copyCode(info.user_code);
      // Open browser after copying so the code is already in clipboard
      window.open(info.verification_uri, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Failed to start GitHub connect');
      setConnectStep('error');
    }
  };

  const handleStartPolling = () => {
    setConnectStep('polling');
    const intervalMs = 5000;
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
        // 'pending' → keep polling
      } catch {
        // network hiccup — keep polling
      }
    }, intervalMs);
  };

  const handleDisconnectGitHub = async () => {
    try {
      await disconnectGitHub();
      await refresh();
    } catch {
      // ignore
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

  // Group models by provider for the <select> optgroups
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
          title="Select model"
        >
          {models.length === 0 && (
            <option value="">{loadingModels ? 'Loading models...' : 'No models available'}</option>
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

        {/* Provider status badges */}
        <div className="model-selector__providers">
          {openaiProvider && (
            <span
              className={`model-selector__badge ${openaiProvider.connected ? 'model-selector__badge--connected' : 'model-selector__badge--disconnected'}`}
              title={openaiProvider.connected ? 'OpenAI connected' : 'OpenAI API key not configured'}
            >
              OpenAI
            </span>
          )}
          {githubProvider && (
            <span
              className={`model-selector__badge ${githubProvider.connected ? 'model-selector__badge--connected' : 'model-selector__badge--disconnected'}`}
              title={githubProvider.connected ? 'GitHub Copilot connected' : 'GitHub Copilot not connected'}
            >
              Copilot
            </span>
          )}
        </div>
      </div>

      {/* GitHub connect / disconnect controls */}
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

      {/* Device code flow UI */}
      {connectStep === 'loading' && (
        <div className="model-selector__connect-flow">Starting GitHub authorization...</div>
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
              title="Copy code"
            >
              {codeCopied ? '✓ Copied' : 'Copy'}
            </button>
          </div>
          {codeCopied && (
            <div className="model-selector__copy-hint">
              Code copied — just paste it on GitHub and authorize.
            </div>
          )}
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
