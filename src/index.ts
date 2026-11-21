import { NightplayRoom } from './nightplay-room.js';
import type { RoomEnv } from './nightplay-room.js';

export { NightplayRoom } from './nightplay-room.js';

interface Env extends RoomEnv {
  ASSETS: Fetcher;
  NIGHTPLAY_ROOM: DurableObjectNamespace<NightplayRoom>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const id = env.NIGHTPLAY_ROOM.idFromName('nightplay-global-room-hub-v1');
      return env.NIGHTPLAY_ROOM.get(id).fetch(request);
    }
    if (url.pathname.startsWith('/api/')) {
      const id = env.NIGHTPLAY_ROOM.idFromName('nightplay-global-room-hub-v1');
      return env.NIGHTPLAY_ROOM.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
