import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';
const api = axios.create({ baseURL: API_BASE, withCredentials: true });

const sentObservationKeys = new Set<string>();

export interface PinInfoObservation {
  metadataId: string;
  tagName: string;
  pinNames: string[];
  propertySignature?: string;
}

function normalizeNames(pinNames: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of pinNames) {
    const n = String(p ?? '').trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export async function reportPinInfoObservation(observation: PinInfoObservation): Promise<void> {
  const pinNames = normalizeNames(observation.pinNames);
  if (!observation.metadataId || pinNames.length === 0) return;

  const key = [
    observation.metadataId,
    observation.tagName,
    observation.propertySignature ?? '',
    ...pinNames,
  ].join('|');
  if (sentObservationKeys.has(key)) return;
  sentObservationKeys.add(key);

  try {
    await api.post('/agent/pin-observations', {
      metadataId: observation.metadataId,
      tagName: observation.tagName,
      pinNames,
      propertySignature: observation.propertySignature,
    });
  } catch {
    // Best-effort telemetry; never block simulator interactions.
  }
}

