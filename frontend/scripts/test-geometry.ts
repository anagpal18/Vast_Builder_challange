import { cameraModel, applyH, project, solveHomography, reprojectionError, gapRectCircle } from '../src/lib/geometry.ts'
const cam = cameraModel({ pos: [-25, -30, 14], target: [0, 0, 0], focal_px: 900, width: 960, height: 540 })
const g: [number, number][] = [[0, 0], [10, -1.75], [-7, 7], [20, 5], [3, -15]]
const img = g.map(([x, y]) => project(cam.P, x, y, 0)!)
console.log('project vs H_g2i:', g.map(([x, y], i) => { const h = applyH(cam.H_g2i, x, y); return Math.hypot(h[0] - img[i][0], h[1] - img[i][1]).toExponential(1) }).join(' '))
console.log('origin in image:', img[0].map((v) => v.toFixed(1)))
console.log('roundtrip i2g:', g.map(([x, y], i) => { const b = applyH(cam.H_i2g, img[i][0], img[i][1]); return Math.hypot(b[0] - x, b[1] - y).toExponential(1) }).join(' '))
const H = solveHomography(img, g)
console.log('DLT reprojection err (m):', reprojectionError(H, img, g).toExponential(2))
console.log('gap: touching side', gapRectCircle(0, 0, 0, 4.5, 1.8, 0, 1.25, 0.35).toFixed(3), 'far', gapRectCircle(0, 0, 90, 4.5, 1.8, 0, 5, 0.35).toFixed(3), 'inside', gapRectCircle(0, 0, 0, 4.5, 1.8, 0.5, 0, 0.35).toFixed(3))
