export interface TranscriptMessage {
  ts: string;
  channel: string;
  author: string;
  text: string;
}

export interface StoredMessage extends TranscriptMessage {
  id: string;
}

export type Scope = 'person' | 'channel';
export type Kind = 'decision' | 'deadline' | 'availability' | 'preference' | 'ownership' | 'fact';
export type Certainty = 'decided' | 'tentative';
export type Status = 'active' | 'superseded';

export const SCOPES: readonly Scope[] = ['person', 'channel'];
export const KINDS: readonly Kind[] = ['decision', 'deadline', 'availability', 'preference', 'ownership', 'fact'];
export const CERTAINTIES: readonly Certainty[] = ['decided', 'tentative'];

export interface CandidateFact {
  subject: string;
  scope: Scope;
  kind: Kind;
  statement: string;
  certainty: Certainty;
  confidence: number;
  source_msg_ids: string[];
}

export interface Memory extends CandidateFact {
  id: number;
  channel: string;
  status: Status;
  created_at: string;
  invalid_at: string | null;
  superseded_by: number | null;
}

export type ReconcileDecision =
  | { op: 'add' }
  | { op: 'update'; target_id: number; statement: string }
  | { op: 'supersede'; target_id: number }
  | { op: 'noop'; target_id?: number };
