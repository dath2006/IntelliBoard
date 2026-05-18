import { create } from 'zustand';

export interface PlanStep {
  label: string;
  description: string;
}

export interface PendingPlanApproval {
  actionId: string;
  sessionId: string;
  title: string;
  description: string;
  steps: PlanStep[];
  resolve: (result: { ok: boolean; payload?: Record<string, unknown> }) => void;
}

interface PlanApprovalState {
  pending: PendingPlanApproval | null;
  /** Called by agentFrontendActions when a plan.approval action arrives */
  setPending: (plan: PendingPlanApproval) => void;
  /** Called by UI buttons — approve with optional revised steps */
  approve: (revisedSteps?: PlanStep[]) => void;
  /** Called by UI buttons — cancel/reject */
  cancel: () => void;
}

export const usePlanApprovalStore = create<PlanApprovalState>((set, get) => ({
  pending: null,

  setPending: (plan) => set({ pending: plan }),

  approve: (revisedSteps) => {
    const { pending } = get();
    if (!pending) return;
    const payload: Record<string, unknown> = {};
    if (revisedSteps) payload.revised_steps = revisedSteps;
    pending.resolve({ ok: true, payload });
    set({ pending: null });
  },

  cancel: () => {
    const { pending } = get();
    if (!pending) return;
    pending.resolve({ ok: false, payload: { reason: 'cancelled' } });
    set({ pending: null });
  },
}));
