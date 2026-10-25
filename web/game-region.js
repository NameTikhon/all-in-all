// Find the pale playing surface used by durak.hlop.de without reading the DOM
// of the shared window. Everything here runs locally, before any API request.
const SCAN_WIDTH = 320;

function validFrame(frame) {
  return frame && Number.isInteger(frame.width) && Number.isInteger(frame.height)
    && frame.width >= 24 && frame.height >= 24
    && frame.data && frame.data.length >= frame.width * frame.height * 4;
}

function paleBoard(red, green, blue) {
  const minimum = Math.min(red, green, blue);
  const maximum = Math.max(red, green, blue);
  return minimum >= 150 && maximum <= 238 && maximum - minimum <= 70
    && green >= red - 8 && blue >= red - 8;
}

function scanFrame(frame) {
  const width = Math.min(SCAN_WIDTH, frame.width);
  const height = Math.max(24, Math.round(frame.height * width / frame.width));
  const pixels = new Uint8Array(width * height * 3);
  const board = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(frame.height - 1, Math.floor((y + 0.5) * frame.height / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(frame.width - 1, Math.floor((x + 0.5) * frame.width / width));
      const source = (sourceY * frame.width + sourceX) * 4;
      const index = y * width + x;
      const red = frame.data[source];
      const green = frame.data[source + 1];
      const blue = frame.data[source + 2];
      pixels[index * 3] = red;
      pixels[index * 3 + 1] = green;
      pixels[index * 3 + 2] = blue;
      board[index] = paleBoard(red, green, blue) ? 1 : 0;
    }
  }
  return { width, height, pixels, board };
}

function candidates({ width, height, board }) {
  const visited = new Uint8Array(board.length);
  const queue = new Int32Array(board.length);
  const regions = [];
  // A two-pixel connection crosses thin white panel borders at this scan size.
  // It does not fill large card-shaped holes in the pale surface.
  const neighbours = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1], [-2, 0], [2, 0], [0, -2], [0, 2]];
  for (let start = 0; start < board.length; start += 1) {
    if (!board[start] || visited[start]) continue;
    let front = 0;
    let back = 1;
    queue[0] = start;
    visited[start] = 1;
    let left = start % width;
    let right = left;
    let top = Math.floor(start / width);
    let bottom = top;
    while (front < back) {
      const index = queue[front++];
      const x = index % width;
      const y = Math.floor(index / width);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (const [dx, dy] of neighbours) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (!board[next] || visited[next]) continue;
        visited[next] = 1;
        queue[back++] = next;
      }
    }
    const regionWidth = right - left + 1;
    const regionHeight = bottom - top + 1;
    const area = regionWidth * regionHeight;
    const aspect = regionWidth / regionHeight;
    if (regionWidth < width * 0.2 || regionHeight < height * 0.22
      || area < width * height * 0.045 || aspect < 0.85 || aspect > 3.3
      || back / area < 0.29) continue;
    regions.push({ left, right, top, bottom, area, count: back, density: back / area });
  }
  return regions;
}

function cardEvidence(scan, region) {
  let warmTop = 0;
  let whiteBottom = 0;
  let darkBottom = 0;
  let warmTopRows = 0;
  let faceBottomRows = 0;
  const height = region.bottom - region.top + 1;
  const width = region.right - region.left + 1;
  for (let y = region.top; y <= region.bottom; y += 1) {
    let warmRow = 0;
    let whiteRow = 0;
    let darkRow = 0;
    const relativeY = (y - region.top) / height;
    for (let x = region.left; x <= region.right; x += 1) {
      const index = (y * scan.width + x) * 3;
      const red = scan.pixels[index];
      const green = scan.pixels[index + 1];
      const blue = scan.pixels[index + 2];
      if (relativeY < 0.36 && red >= 105 && red - green >= 22
        && green >= 40 && blue <= green + 20) warmRow += 1;
      if (relativeY > 0.60 && Math.min(red, green, blue) >= 235
        && Math.max(red, green, blue) - Math.min(red, green, blue) <= 30) whiteRow += 1;
      if (relativeY > 0.60 && Math.max(red, green, blue) <= 105) darkRow += 1;
    }
    warmTop += warmRow;
    whiteBottom += whiteRow;
    darkBottom += darkRow;
    if (warmRow >= width * 0.06) warmTopRows += 1;
    if (whiteRow >= width * 0.06 && darkRow >= 1) faceBottomRows += 1;
  }
  // Brown card backs above and white card faces below distinguish the table
  // from ordinary light web pages, settings forms, and the helper itself.
  const backs = warmTop / region.area >= 0.008 && warmTopRows >= Math.max(2, height * 0.04);
  const faces = whiteBottom / region.area >= 0.012
    && darkBottom / region.area >= 0.0018
    && faceBottomRows >= Math.max(2, height * 0.025);
  return { backs, faces, warmTop, whiteBottom, darkBottom };
}

/**
 * Return a normalized { x, y, width, height, confidence } for the whole pale
 * Durak playing surface, or null when it cannot be identified locally.
 * The caller should keep a detected rectangle for the capture session so
 * animations inside the cards cannot make its edges move between frames.
 */
export function detectGameRegion(frame) {
  if (!validFrame(frame)) return null;
  const scan = scanFrame(frame);
  const scored = candidates(scan).map(region => ({ region, evidence: cardEvidence(scan, region) }))
    .filter(({ evidence }) => evidence.backs && evidence.faces)
    .sort((left, right) => right.region.area - left.region.area);
  if (!scored.length) return null;
  const { region } = scored[0];
  const padding = 1;
  const left = Math.max(0, region.left - padding);
  const top = Math.max(0, region.top - padding);
  const right = Math.min(scan.width, region.right + 1 + padding);
  const bottom = Math.min(scan.height, region.bottom + 1 + padding);
  return {
    x: left / scan.width,
    y: top / scan.height,
    width: (right - left) / scan.width,
    height: (bottom - top) / scan.height,
    confidence: Math.min(0.98, 0.8 + region.density * 0.18),
  };
}

/** Area-averaged RGB grid of a locked rectangle; unrelated UI is excluded. */
export function gameRegionSignature(frame, region, { columns = 96, rows = 60 } = {}) {
  if (!validFrame(frame) || !region || !Number.isInteger(columns) || !Number.isInteger(rows)
    || columns < 1 || rows < 1 || columns > 320 || rows > 240
    || ![region.x, region.y, region.width, region.height].every(Number.isFinite)
    || region.width <= 0 || region.height <= 0) return null;
  const left = Math.max(0, Math.min(frame.width - 1, Math.floor(region.x * frame.width)));
  const top = Math.max(0, Math.min(frame.height - 1, Math.floor(region.y * frame.height)));
  const right = Math.max(left + 1, Math.min(frame.width, Math.ceil((region.x + region.width) * frame.width)));
  const bottom = Math.max(top + 1, Math.min(frame.height, Math.ceil((region.y + region.height) * frame.height)));
  const signature = new Uint8Array(columns * rows * 3);
  for (let row = 0; row < rows; row += 1) {
    const y0 = Math.floor(top + (bottom - top) * row / rows);
    const y1 = Math.max(y0 + 1, Math.ceil(top + (bottom - top) * (row + 1) / rows));
    for (let column = 0; column < columns; column += 1) {
      const x0 = Math.floor(left + (right - left) * column / columns);
      const x1 = Math.max(x0 + 1, Math.ceil(left + (right - left) * (column + 1) / columns));
      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;
      for (let y = y0; y < Math.min(y1, frame.height); y += 1) {
        for (let x = x0; x < Math.min(x1, frame.width); x += 1) {
          const pixel = (y * frame.width + x) * 4;
          red += frame.data[pixel]; green += frame.data[pixel + 1]; blue += frame.data[pixel + 2];
          count += 1;
        }
      }
      const index = (row * columns + column) * 3;
      signature[index] = Math.round(red / count);
      signature[index + 1] = Math.round(green / count);
      signature[index + 2] = Math.round(blue / count);
    }
  }
  return signature;
}
