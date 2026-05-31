// session service — what `jibo.init()` talks to.
//
// On the real runtime, init() sets up the registry context (host/token for
// service discovery). Here it just hands the skill its run-mode + the logical
// face resolution so the in-iframe FaceRenderer shim can size its canvas like
// the real 1280×720 face.

import { FACE_WIDTH, FACE_HEIGHT } from '../face-overlay.js';

export function createSessionService() {
  return {
    init() {
      return {
        runMode: 'simulator',
        face: { width: FACE_WIDTH, height: FACE_HEIGHT },
      };
    },
  };
}
