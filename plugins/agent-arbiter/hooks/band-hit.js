export default function bandHit(_props, surface) {
  surface.onPointer(event => {
    if (event.type === 'up' && event.button === 'left' &&
        event.x >= 0 && event.x < surface.columns && event.y >= 0 && event.y < surface.rows) {
      surface.post('toggle');
    }
  });
  surface.onKey(event => {
    if (event.key === 'return' || event.key === ' ') surface.post('toggle');
  });
  return surface.elements.Box({ width: '100%', height: '100%', children: [] });
}
