import { json } from '../http';

export function getHealth(): Response {
  return json({ status: 'ok' });
}
