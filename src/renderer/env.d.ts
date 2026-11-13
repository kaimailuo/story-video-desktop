import type { DesktopAPI } from '../shared/project';

declare global {
  interface Window { desktop?: DesktopAPI }
}
