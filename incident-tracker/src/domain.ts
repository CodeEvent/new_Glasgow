export const HUBS = ['East Hub', 'West Hub', 'South Hub', 'Hospitality Hub'] as const;
export type Hub = (typeof HUBS)[number];

export const STATUSES = ['cooling_off', 'completely_refused', 'admitted'] as const;
export type IncidentStatus = (typeof STATUSES)[number];

/** What the steward selected on the intake form. */
export const INTAKE_ACTIONS = ['cool_off', 'refused', 'admitted'] as const;
export type IntakeAction = (typeof INTAKE_ACTIONS)[number];

/** What gets written to scan_events.action_logged. */
export type LoggedAction =
  | 'initial_refusal'
  | 'initial_cool_off'
  | 'bypass_attempt'
  | 'unauthorized_admission'
  | 'cleared_admission'
  | 'repeat_scan';

export interface TicketRow {
  ticket_id: string;
  current_status: IncidentStatus;
  party_size: number;
  description: string;
  reasoning: string;
  cool_down_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ScanEventRow {
  id: string;
  ticket_id: string;
  hub_location: Hub;
  latitude: string | null;
  longitude: string | null;
  steward_name: string;
  action_logged: LoggedAction;
  is_breach_event: boolean;
  timestamp: Date;
}
