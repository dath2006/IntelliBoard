import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';
const api = axios.create({ baseURL: API_BASE, withCredentials: true });

export interface ProviderStatus {
  id: string;
  label: string;
  auth_type: string;
  description: string;
  connected: boolean;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  provider_label: string;
}

export interface GitHubConnectInfo {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface GitHubPollResult {
  status: 'pending' | 'authorized' | 'expired' | 'denied' | 'error';
  message?: string | null;
}

export async function listProviders(): Promise<ProviderStatus[]> {
  const { data } = await api.get<ProviderStatus[]>('/llm/providers');
  return data;
}

export async function listModels(): Promise<ModelInfo[]> {
  const { data } = await api.get<ModelInfo[]>('/llm/models');
  return data;
}

export async function startGitHubConnect(): Promise<GitHubConnectInfo> {
  const { data } = await api.post<GitHubConnectInfo>('/llm/github/connect');
  return data;
}

export async function pollGitHubConnect(device_code: string): Promise<GitHubPollResult> {
  const { data } = await api.post<GitHubPollResult>('/llm/github/poll', { device_code });
  return data;
}

export async function disconnectGitHub(): Promise<void> {
  await api.delete('/llm/github/disconnect');
}
