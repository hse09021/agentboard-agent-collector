import { v4 as uuidv4 } from "uuid";

export function generateDeviceId(): string {
  return `dev_${uuidv4().replace(/-/g, "")}`;
}
