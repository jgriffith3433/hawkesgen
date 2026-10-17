// The service's event bus: job updates ('job') and library changes ('library'). The API streams both to dashboards
// and editors (GET /v1/events), so an open editor updates when a job lands or someone picks a take.

import { EventEmitter } from 'node:events';

export const events = new EventEmitter();
events.setMaxListeners(200);
