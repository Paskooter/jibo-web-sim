// Make WebGL canvases in the skill iframe keep their drawing buffer.
//
// By default a WebGL canvas is cleared once it has been presented, so reading it (drawImage)
// from anywhere but the same task that rendered it gives a blank image, and which
// requestAnimationFrame callback runs first is not ours to control. The screen dock
// (ui/screen-dock.js) copies the face every frame; with the buffer preserved that copy
// works whenever it runs. The cost is the browser skipping a buffer swap optimisation on
// a 1280x720 face, which is nothing next to the 3D viewport.
//
// Imported first in boot.js, so it is in place before the runtime creates its PixiJS renderer.

const proto = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype;
if (proto && !proto.__keepBuffer) {
  const getContext = proto.getContext;
  proto.getContext = function (type, attrs) {
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
      attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
    }
    return getContext.call(this, type, attrs);
  };
  proto.__keepBuffer = true;
}
