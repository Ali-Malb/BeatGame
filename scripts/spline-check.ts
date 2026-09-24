import { RoadSpline } from '../src/game/environment/roadSpline';
const sp = new RoadSpline(90210);
sp.ensure(30000);
const lanes = new Set<number>();
let tunnels = 0, bridges = 0;
let yMin = Infinity, yMax = -Infinity;
const pt = { x: 0, y: 0, z: 0, yaw: 0, rx: 1, rz: 0, kappa: 0, s: 0, slope: 0 };
for (let s = 0; s < 30000; s += 25) {
  lanes.add(sp.lanesAt(s));
  if (sp.isTunnelAt(s)) tunnels++;
  if (sp.isBridgeAt(s)) bridges++;
  sp.get(s, pt);
  yMin = Math.min(yMin, pt.y); yMax = Math.max(yMax, pt.y);
}
console.log('lanes:', [...lanes].sort(), 'tunnel m:', tunnels * 25, 'bridge m:', bridges * 25, 'y:', yMin.toFixed(1), '-', yMax.toFixed(1));
console.log('tunnel ranges:', JSON.stringify(sp.tunnelRangesUpTo(30000).slice(0, 6)));
