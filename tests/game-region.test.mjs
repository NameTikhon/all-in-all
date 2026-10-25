import test from 'node:test';
import assert from 'node:assert/strict';
import { detectGameRegion, gameRegionSignature } from '../web/game-region.js';

function frame(width = 400, height = 240, color = [20, 43, 45]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([...color, 255], offset);
  return { width, height, data };
}

function rectangle(image, x, y, width, height, color) {
  for (let row = Math.max(0, y); row < Math.min(image.height, y + height); row += 1) {
    for (let column = Math.max(0, x); column < Math.min(image.width, x + width); column += 1) {
      image.data.set([...color, 255], (row * image.width + column) * 4);
    }
  }
}

function game(image, { x = 10, y = 48, width = 180, height = 132 } = {}) {
  rectangle(image, x - 2, y - 8, width + 4, height + 23, [112, 139, 143]);
  rectangle(image, x, y, width, height, [173, 197, 201]);
  rectangle(image, x + 3, y + Math.round(height * 0.32), width - 6, Math.round(height * 0.37), [213, 226, 228]);
  const cardWidth = Math.round(width * 0.125);
  const cardHeight = Math.round(height * 0.23);
  const pipWidth = Math.max(3, Math.round(cardWidth * 0.14));
  const pipHeight = Math.max(5, Math.round(cardHeight * 0.17));
  for (let card = 0; card < 6; card += 1) {
    const cardX = x + 4 + card * Math.round(width * 0.075);
    rectangle(image, cardX, y + 4, cardWidth, cardHeight, [250, 250, 249]);
    rectangle(image, cardX + 1, y + 5, cardWidth - 2, cardHeight - 2, [178, 105, 62]);
    const handY = y + Math.round(height * 0.74);
    rectangle(image, cardX, handY, cardWidth, cardHeight, [251, 251, 250]);
    rectangle(image, cardX + 2, handY + 3, pipWidth, pipHeight, [18, 22, 24]);
    rectangle(image, cardX + 3, handY + Math.round(cardHeight * 0.4), pipWidth, pipHeight, card % 2 ? [207, 39, 32] : [18, 22, 24]);
  }
  rectangle(image, x + width - cardWidth - 5, y + Math.round(height * 0.4), cardWidth, cardHeight, [251, 251, 250]);
  rectangle(image, x + width - cardWidth - 3, y + Math.round(height * 0.4) + 3, 3, 5, [15, 18, 18]);
  return { x, y, width, height };
}

function pixels(region, image) {
  return {
    left: region.x * image.width,
    top: region.y * image.height,
    right: (region.x + region.width) * image.width,
    bottom: (region.y + region.height) * image.height,
  };
}

test('detects whole board beside a dark assistant, excluding header, footer and sidebar', () => {
  const image = frame();
  const board = game(image);
  rectangle(image, 210, 0, 190, 240, [24, 35, 43]);
  rectangle(image, 222, 28, 160, 35, [36, 57, 48]);
  rectangle(image, 222, 132, 160, 65, [34, 57, 48]);
  rectangle(image, 160, 32, 22, 5, [252, 252, 252]);
  const region = detectGameRegion(image);
  assert.ok(region);
  assert.ok(region.confidence >= 0.8);
  const bounds = pixels(region, image);
  assert.ok(bounds.left <= board.x + 2);
  assert.ok(bounds.top <= board.y + 3);
  assert.ok(bounds.right >= board.x + board.width - 2);
  assert.ok(bounds.bottom >= board.y + board.height - 2);
  assert.ok(bounds.top > 38, 'online/header counter is not part of the crop');
  assert.ok(bounds.bottom < 188, 'statistics footer is not part of the crop');
  assert.ok(bounds.right < 205, 'assistant panel is not part of the crop');
});

test('finds same relative board when game takes the full viewport', () => {
  const image = frame(400, 320);
  const board = game(image, { x: 22, y: 54, width: 355, height: 230 });
  const region = detectGameRegion(image);
  assert.ok(region);
  const bounds = pixels(region, image);
  assert.ok(Math.abs(bounds.left - board.x) < 6);
  assert.ok(Math.abs(bounds.top - board.y) < 6);
  assert.ok(Math.abs(bounds.right - board.x - board.width) < 6);
  assert.ok(Math.abs(bounds.bottom - board.y - board.height) < 6);
});

test('does not identify blank dark or blank white screens as a game', () => {
  assert.equal(detectGameRegion(frame()), null);
  assert.equal(detectGameRegion(frame(400, 240, [255, 255, 255])), null);
  assert.equal(detectGameRegion(frame(400, 240, [185, 195, 200])), null);
});

test('does not identify a light settings form with white fields and black text', () => {
  const image = frame();
  rectangle(image, 12, 40, 180, 145, [185, 195, 200]);
  for (let field = 0; field < 4; field += 1) {
    rectangle(image, 22, 58 + field * 28, 150, 20, [250, 250, 250]);
    rectangle(image, 30, 66 + field * 28, 80, 4, [30, 30, 30]);
  }
  assert.equal(detectGameRegion(image), null);
});

test('warm content alone is not enough to identify a game', () => {
  const image = frame();
  rectangle(image, 12, 40, 180, 145, [185, 195, 200]);
  rectangle(image, 22, 48, 150, 40, [180, 110, 70]);
  assert.equal(detectGameRegion(image), null);
});

test('locked region signature ignores changing helper text and page counters', () => {
  const image = frame();
  game(image);
  const region = detectGameRegion(image);
  const initial = gameRegionSignature(image, region);
  rectangle(image, 210, 0, 190, 240, [240, 240, 240]);
  rectangle(image, 155, 30, 35, 6, [255, 255, 255]);
  rectangle(image, 15, 190, 160, 8, [250, 250, 250]);
  assert.deepEqual(gameRegionSignature(image, region), initial);
});

test('region signature changes when a played card leaves the hand', () => {
  const image = frame();
  const board = game(image);
  const region = detectGameRegion(image);
  const initial = gameRegionSignature(image, region);
  rectangle(image, board.x + 4, board.y + 98, 14, 30, [173, 197, 201]);
  assert.notDeepEqual(gameRegionSignature(image, region), initial);
});

test('RGB signatures retain suit color changes that grayscale can miss', () => {
  const image = frame();
  game(image);
  const region = detectGameRegion(image);
  rectangle(image, 90, 155, 5, 10, [210, 35, 35]);
  const initial = gameRegionSignature(image, region);
  rectangle(image, 90, 155, 5, 10, [30, 95, 30]);
  assert.notDeepEqual(gameRegionSignature(image, region), initial);
});

test('rejects incomplete image data and invalid signature dimensions', () => {
  assert.equal(detectGameRegion(null), null);
  assert.equal(detectGameRegion({ width: 400, height: 240, data: [] }), null);
  assert.equal(gameRegionSignature(frame(), null), null);
  assert.equal(gameRegionSignature(frame(), { x: 0, y: 0, width: 1, height: 1 }, { columns: 0 }), null);
});
