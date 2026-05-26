// media service — photo storage (jibo.media).
//
// Mirrors sdk-archive/jibo dts/media.d.ts: storePhoto / getPhoto / getUrlById.
// jibo.lps.takePhoto captures the viewport and stores the data URL here; skills
// retrieve it by id. (Video recording is out of scope for the web sim.)
//
// Returns { service, store }: service is registered on the bridge; store() is
// the host entry the photo capture calls.

export function createMediaService() {
  const photos = new Map();   // id -> dataURL
  let seq = 0;

  function store(dataUrl) {
    const id = `photo-${++seq}`;
    photos.set(id, dataUrl);
    return { id, url: dataUrl };
  }

  return {
    store,
    service: {
      getUrlById(id) { return photos.get(id) || null; },
      getPhoto(id) { return photos.get(id) || null; },
      storePhoto() { return null; },   // buffer-based store unsupported in sim
    },
  };
}
