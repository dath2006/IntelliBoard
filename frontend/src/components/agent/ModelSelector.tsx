import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, Loader2, Cpu, UserKey, Link2Off, Key } from 'lucide-react';
import type { ModelInfo, ProviderStatus } from '../../services/llmProviders';
import {
  disconnectGitHub,
  listModels,
  listProviders,
  pollGitHubConnect,
  startGitHubConnect,
} from '../../services/llmProviders';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface Props {
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}

type ConnectStep = 'idle' | 'loading' | 'show_code' | 'polling' | 'done' | 'error';

function ProviderBadges({
  openaiProvider,
  openrouterProvider,
  githubProvider,
  compact,
}: {
  openaiProvider?: ProviderStatus;
  openrouterProvider?: ProviderStatus;
  githubProvider?: ProviderStatus;
  compact?: boolean;
}) {
  const chip = (connected: boolean, label: string, title: string, icon: React.ReactNode) => (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
        connected
          ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
          : 'border-border bg-muted/50 text-muted-foreground',
        compact && 'px-1.5',
      )}
    >
      {icon}
      <span className="max-w-[72px] truncate">{label}</span>
      {connected ? <Check className="size-2.5 shrink-0" /> : null}
    </span>
  );

  return (
    <div className="flex flex-wrap gap-1.5">
      {openrouterProvider
        ? chip(
            openrouterProvider.connected,
            'OpenRouter',
            openrouterProvider.connected ? 'OpenRouter API key configured' : 'No API key',
            <Key className="size-2.5 opacity-70" />,
          )
        : null}
      {openaiProvider
        ? chip(
            openaiProvider.connected,
            'OpenAI',
            openaiProvider.connected ? 'OpenAI API key configured' : 'No API key',
            <Key className="size-2.5 opacity-70" />,
          )
        : null}
      {githubProvider
        ? chip(
            githubProvider.connected,
            'Copilot',
            githubProvider.connected ? 'GitHub Copilot connected' : 'Not connected',
            <UserKey className="size-2.5 opacity-70" />,
          )
        : null}
    </div>
  );
}

// ── Full ModelSelector (agent meta / legacy layouts) ─────────────────────────

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
      /* ignore */
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
  const openrouterProvider = providers.find((p) => p.id === 'openrouter');
  const openaiModels = models.filter((m) => m.provider === 'openai');
  const openrouterModels = models.filter((m) => m.provider === 'openrouter');
  const githubModels = models.filter((m) => m.provider === 'github');

  const selectDisabled = disabled || loadingModels || models.length === 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-stretch gap-2">
        <Select
          value={models.some((m) => m.id === value) ? value : undefined}
          onValueChange={onChange}
          disabled={selectDisabled}
        >
          <SelectTrigger className="h-8 min-w-0 flex-1 text-xs" size="sm">
            <SelectValue placeholder={loadingModels ? 'Loading models…' : 'No models available'} />
          </SelectTrigger>
          <SelectContent>
            {openrouterModels.length > 0 && (
              <SelectGroup>
                <SelectLabel>OpenRouter</SelectLabel>
                {openrouterModels.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="text-xs">
                    {m.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
            {openrouterModels.length > 0 && openaiModels.length > 0 ? <SelectSeparator /> : null}
            {openaiModels.length > 0 && (
              <SelectGroup>
                <SelectLabel>OpenAI</SelectLabel>
                {openaiModels.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="text-xs">
                    {m.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
            {(openrouterModels.length > 0 || openaiModels.length > 0) && githubModels.length > 0 ? (
              <SelectSeparator />
            ) : null}
            {githubModels.length > 0 && (
              <SelectGroup>
                <SelectLabel>GitHub Copilot</SelectLabel>
                {githubModels.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="text-xs">
                    {m.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>

        <ProviderBadges
          openaiProvider={openaiProvider}
          githubProvider={githubProvider}
          openrouterProvider={openrouterProvider}
        />
      </div>

      <Separator />

      {githubProvider && !githubProvider.connected && connectStep === 'idle' && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-full text-xs"
          disabled={disabled}
          onClick={handleGitHubConnect}
        >
          Connect GitHub Copilot
        </Button>
      )}
      {githubProvider && githubProvider.connected && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full text-xs text-destructive hover:bg-destructive/10"
          disabled={disabled}
          onClick={handleDisconnectGitHub}
        >
          Disconnect GitHub Copilot
        </Button>
      )}

      {connectStep === 'loading' && (
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Starting GitHub authorization…
        </div>
      )}
      {connectStep === 'show_code' && (
        <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3 text-xs">
          <p className="text-muted-foreground">
            Enter this code at{' '}
            <a
              className="text-primary underline underline-offset-2"
              href={verificationUri}
              target="_blank"
              rel="noopener noreferrer"
            >
              github.com/device
            </a>
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <span className="font-mono text-lg font-bold tracking-[0.2em]">{userCode}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(
                'text-xs shrink-0',
                codeCopied && 'border-emerald-500/40 text-emerald-600',
              )}
              onClick={() => void copyCode(userCode)}
            >
              {codeCopied ? <Check className="size-3.5" /> : 'Copy'}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="button" size="sm" className="text-xs flex-1" onClick={handleStartPolling}>
              I’ve authorized — continue
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-xs flex-1"
              onClick={handleCancelConnect}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {connectStep === 'polling' && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" />
            Waiting for GitHub authorization…
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start text-xs"
            onClick={handleCancelConnect}
          >
            Cancel
          </Button>
        </div>
      )}
      {connectStep === 'done' && (
        <div className="rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-400">
          GitHub Copilot connected.
        </div>
      )}
      {connectStep === 'error' && connectError && (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {connectError}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start text-xs"
            onClick={handleCancelConnect}
          >
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
};

// ── Compact selector (footer) ────────────────────────────────────────────────

interface CompactProps {
  value: string;
  onChange: (modelId: string) => void;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  disabled?: boolean;
}

export const CompactModelSelector: React.FC<CompactProps> = ({
  value,
  onChange,
  open,
  onOpenChange,
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
          onOpenChange(false);
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
  const openrouterProvider = providers.find((p) => p.id === 'openrouter');
  const openaiModels = models.filter((m) => m.provider === 'openai');
  const openrouterModels = models.filter((m) => m.provider === 'openrouter');
  const githubModels = models.filter((m) => m.provider === 'github');

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || loadingModels}
          className="h-8 max-w-full justify-between gap-1.5 px-2 font-normal text-xs"
          title="Select model"
        >
          <span className="inline-flex items-center gap-1.5 min-w-0">
            <Cpu className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{modelLabel}</span>
          </span>
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-72">
        <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Models
        </DropdownMenuLabel>
        <div className="px-2 pb-2">
          <ProviderBadges
            openaiProvider={openaiProvider}
            githubProvider={githubProvider}
            openrouterProvider={openrouterProvider}
            compact
          />
        </div>

        {openrouterModels.length > 0 && (
          <>
            <DropdownMenuLabel className="pt-1 text-[10px] text-muted-foreground/90">
              OpenRouter
            </DropdownMenuLabel>
            {openrouterModels.map((m) => (
              <DropdownMenuItem
                key={m.id}
                className="gap-2 text-xs"
                onSelect={() => {
                  onChange(m.id);
                  onOpenChange(false);
                }}
              >
                {m.id === value ? (
                  <Check className="size-3.5 text-primary" />
                ) : (
                  <span className="size-3.5" />
                )}
                <span className="truncate">{m.label}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}

        {openaiModels.length > 0 && (
          <>
            {openrouterModels.length > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="pt-1 text-[10px] text-muted-foreground/90">
              OpenAI
            </DropdownMenuLabel>
            {openaiModels.map((m) => (
              <DropdownMenuItem
                key={m.id}
                className="gap-2 text-xs"
                onSelect={() => {
                  onChange(m.id);
                  onOpenChange(false);
                }}
              >
                {m.id === value ? (
                  <Check className="size-3.5 text-primary" />
                ) : (
                  <span className="size-3.5" />
                )}
                <span className="truncate">{m.label}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}

        {githubModels.length > 0 && (
          <>
            {openrouterModels.length > 0 || openaiModels.length > 0 ? (
              <DropdownMenuSeparator />
            ) : null}
            <DropdownMenuLabel className="text-[10px] text-muted-foreground/90">
              GitHub Copilot
            </DropdownMenuLabel>
            {githubModels.map((m) => (
              <DropdownMenuItem
                key={m.id}
                className="gap-2 text-xs"
                onSelect={() => {
                  onChange(m.id);
                  onOpenChange(false);
                }}
              >
                {m.id === value ? (
                  <Check className="size-3.5 text-primary" />
                ) : (
                  <span className="size-3.5" />
                )}
                <span className="truncate">{m.label}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}

        <DropdownMenuSeparator />

        {githubProvider && !githubProvider.connected && connectStep === 'idle' && (
          <DropdownMenuItem className="text-xs gap-2" onSelect={(e) => e.preventDefault()}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-7 w-full gap-1.5 text-xs"
              onClick={handleGitHubConnect}
            >
              <UserKey className="size-3" />
              Connect GitHub Copilot
            </Button>
          </DropdownMenuItem>
        )}
        {githubProvider && githubProvider.connected && (
          <DropdownMenuItem
            className="text-xs"
            variant="destructive"
            onSelect={(e) => e.preventDefault()}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-full justify-start gap-1.5 text-xs text-destructive hover:text-destructive"
              onClick={handleDisconnectGitHub}
            >
              <Link2Off className="size-3" />
              Disconnect Copilot
            </Button>
          </DropdownMenuItem>
        )}

        {connectStep === 'loading' && (
          <div className="flex items-center gap-2 px-2 py-2 text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Starting GitHub auth…
          </div>
        )}

        {connectStep === 'show_code' && (
          <div className="space-y-2 border-t border-border px-2 py-2 text-[11px]">
            <p className="text-muted-foreground">
              Open{' '}
              <a
                className="text-primary underline underline-offset-2"
                href={verificationUri}
                target="_blank"
                rel="noopener noreferrer"
              >
                device login
              </a>{' '}
              and enter:
            </p>
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2 py-1.5 font-mono text-sm font-semibold tracking-[0.12em]">
              <span className="min-w-0 flex-1 truncate">{userCode}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 shrink-0 px-2 text-[10px]"
                onClick={() => void copyCode(userCode)}
              >
                {codeCopied ? <Check className="size-3" /> : 'Copy'}
              </Button>
            </div>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                className="h-7 flex-1 text-[11px]"
                onClick={handleStartPolling}
              >
                Authorized
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 flex-1 text-[11px]"
                onClick={() => setConnectStep('idle')}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {connectStep === 'polling' && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-2 py-2 text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Waiting…
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => {
                stopPolling();
                setConnectStep('idle');
              }}
            >
              Cancel
            </Button>
          </div>
        )}

        {connectStep === 'done' && (
          <div className="flex items-center gap-1.5 px-2 py-2 text-[11px] text-emerald-600 dark:text-emerald-400">
            <Check className="size-3.5" />
            Connected!
          </div>
        )}

        {connectStep === 'error' && connectError && (
          <div className="space-y-1 border-t border-border px-2 py-2 text-[11px] text-destructive">
            {connectError}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => setConnectStep('idle')}
            >
              Dismiss
            </Button>
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
