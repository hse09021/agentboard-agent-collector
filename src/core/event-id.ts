import { v4 as uuidv4 } from "uuid";

export function generateEventId(): string {
  return `evt_${uuidv4().replace(/-/g, "")}`;
}

export function generateSessionId(): string {
  return `ses_${uuidv4().replace(/-/g, "")}`;
}
