// The scene's logic that does not need a GPU: scroll story, camera path, frame watchdog, card layout, drain spiral, browser detection.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cameraPose, cameraPoses } from '../../src/hero/camera.ts';
import { FIELD_LENGTH, NEAR_Z, buildCards, cardDepth, seededRandom } from '../../src/hero/cards.ts';
import { detectBrowser, isSoftwareRenderer } from '../../src/hero/detect.ts';
import { encodeField } from '../../src/hero/field.ts';
import { PEOPLE, SLOP } from '../../src/hero/replies.ts';
import { bridgeStep, drainPlacement } from '../../src/hero/story-page.ts';
import { damp, pageEnding, storyPicture, storyState, type StoryLayout, type StoryState } from '../../src/hero/story.ts';
import { cheaperPixelRatio, frameWatchdog } from '../../src/hero/watchdog.ts';

const LAYOUT: StoryLayout = { vh: 900, threadTop: 900, bridgeTop: 2500, bridgeBottom: 6100, drainTop: 6300, drainBottom: 9180 };

describe('story', () => {
  test('starts in the flood with nothing played', () => {
    assert.deepEqual(storyState(0, LAYOUT), { stage: 0, bridge: 0, drain: 0 });
  });

  test('the stage only moves forward with the scroll', () => {
    let previous = -1;
    for (let y = 0; y <= 9500; y += 25) {
      const { stage } = storyState(y, LAYOUT);
      assert.ok(stage >= previous, `stage went back at y=${y}: ${stage} after ${previous}`);
      previous = stage;
    }
    assert.equal(previous, 3);
  });

  test('the bridge plays only while it is pinned', () => {
    assert.equal(storyState(2500, LAYOUT).bridge, 0);
    const middle = storyState((2500 + 225 + 6100 - 810) / 2, LAYOUT).bridge;
    assert.ok(middle > 0.45 && middle < 0.55, `middle of the bridge: ${middle}`);
    assert.equal(storyState(6100, LAYOUT).bridge, 1);
  });

  test('the drain finishes before its section ends', () => {
    assert.equal(storyState(6300, LAYOUT).drain, 0);
    assert.equal(storyState(9180 - 585, LAYOUT).drain, 1);
  });

  test('a page with no room for an act never divides by zero', () => {
    const flat: StoryLayout = { vh: 900, threadTop: 0, bridgeTop: 0, bridgeBottom: 0, drainTop: 0, drainBottom: 0 };
    for (const value of Object.values(storyState(100, flat))) assert.ok(Number.isFinite(value));
  });

  test('the page ending plays only in the last eighth of a screen, and it is complete at the end on every screen', () => {
    for (const vh of [390, 778, 1440]) {
      assert.equal(pageEnding(vh, vh), 0, 'one screen before the end');
      assert.equal(pageEnding(vh * 0.2, vh), 0);
      const half = pageEnding(vh * 0.075, vh);
      assert.ok(half > 0.45 && half < 0.55, `half way: ${half}`);
      assert.equal(pageEnding(0, vh), 1);
      assert.equal(pageEnding(-40, vh), 1, 'an overscroll past the end');
    }
  });

  test('damp reaches the target and does not overshoot', () => {
    let value = 0;
    for (let i = 0; i < 400; i++) {
      value = damp(value, 1, 0.14, 1 / 60);
      assert.ok(value <= 1);
    }
    assert.equal(value, 1);
  });
});

describe('no step on the screen', () => {
  // The screen of a reported fault (1356 x 626), three desktops, four phones and two phones on their side.
  const SCREENS = [[1356, 626], [1440, 900], [1920, 1080], [1024, 768], [320, 568], [360, 740], [390, 844], [430, 932], [667, 375], [844, 390]] as const;
  const FOOTER = 120;

  /** The page as site.css lays it out: a hero of one screen, the thread, a bridge track of 4 screens and a drain track of 3.2 screens. */
  function layoutFor(vh: number): StoryLayout {
    const bridgeTop = vh + 1600;
    const drainTop = bridgeTop + 4 * vh;
    return { vh, threadTop: vh, bridgeTop, bridgeBottom: drainTop, drainTop, drainBottom: drainTop + 3.2 * vh };
  }

  /** Every number that places something on the screen for one story state. */
  function drawn(state: StoryState, ending: number, aspect: number): Record<string, number> {
    const pose = cameraPose(cameraPoses(aspect), state.stage, state.drain);
    const values: Record<string, number> = { ...storyPicture(state, ending) };
    for (const part of ['position', 'target', 'up'] as const) pose[part].forEach((value, axis) => (values[`camera ${part} ${'xyz'[axis]}`] = value));
    return values;
  }

  /** Fails when a value moves more than its limit between two neighbouring states. World units for the camera, a share of the full range for the rest. */
  function assertNoStep(before: Record<string, number>, after: Record<string, number>, cameraLimit: number, pictureLimit: number, where: string): void {
    for (const [name, value] of Object.entries(after)) {
      const step = Math.abs(value - before[name]!);
      assert.ok(step <= (name.startsWith('camera') ? cameraLimit : pictureLimit), `${name} steps by ${step.toFixed(3)} ${where}`);
    }
  }

  for (const [width, height] of SCREENS) {
    test(`${width} x ${height}: one pixel of scroll never moves the camera or a picture value in a step`, () => {
      const layout = layoutFor(height);
      const end = layout.drainBottom + FOOTER - height;
      const at = (y: number) => drawn(storyState(y, layout), pageEnding(end - y, height), width / height);
      let before = at(0);
      for (let y = 1; y <= end; y++) {
        const after = at(y);
        assertNoStep(before, after, 0.5, 0.06, `at scroll ${y} of ${end}`);
        before = after;
      }
    });
  }

  test('a fast scroll moves the stage and the drain apart: still no step, at any pair of them', () => {
    for (const aspect of [1356 / 626, 390 / 844]) {
      for (let fixed = 0; fixed <= 1; fixed += 0.125) {
        let alongStage = drawn({ stage: 0, bridge: fixed, drain: fixed }, 0, aspect);
        let alongDrain = drawn({ stage: fixed * 3, bridge: 0, drain: 0 }, 0, aspect);
        for (let i = 1; i <= 3000; i++) {
          const nextStage = drawn({ stage: i / 1000, bridge: fixed, drain: fixed }, 0, aspect);
          assertNoStep(alongStage, nextStage, 0.3, 0.02, `at stage ${i / 1000}, drain ${fixed}`);
          alongStage = nextStage;
          const nextDrain = drawn({ stage: fixed * 3, bridge: i / 3000, drain: i / 3000 }, 0, aspect);
          assertNoStep(alongDrain, nextDrain, 0.3, 0.02, `at stage ${fixed * 3}, drain ${i / 3000}`);
          alongDrain = nextDrain;
        }
      }
    }
  });

  test('the beam and the votes are gone before the bridge layer leaves, so nothing switches off on the screen', () => {
    for (let stage = 2; stage <= 3; stage += 0.001) {
      const picture = storyPicture({ stage, bridge: 1, drain: 0 }, 0);
      assert.ok(picture.beam <= picture.bridgeFade, `the beam outlives its fade at stage ${stage}`);
    }
    assert.equal(storyPicture({ stage: 2, bridge: 1, drain: 0 }, 0).beam, 1, 'the bridge stands while the act is pinned');
    assert.equal(storyPicture({ stage: 3, bridge: 1, drain: 0 }, 0).beam, 0, 'it is gone when the drain act starts');
  });

  test('an account on the ring of the drain moves without a step', () => {
    for (const index of [0, 6, 13]) {
      let before = drainPlacement(index, 14, 0, 300, 200);
      for (let i = 1; i <= 1000; i++) {
        const after = drainPlacement(index, 14, i / 1000, 300, 200);
        assert.ok(Math.hypot(after.x - before.x, after.y - before.y) <= 6, `account ${index} steps at drain ${i / 1000}`);
        assert.ok(Math.abs(after.opacity - before.opacity) <= 0.05 && Math.abs(after.scale - before.scale) <= 0.05, `account ${index} flashes at drain ${i / 1000}`);
        before = after;
      }
    }
  });
});

describe('bridge captions', () => {
  test('the bridge is the last step and only after both sides voted', () => {
    assert.equal(bridgeStep(0), 0);
    assert.equal(bridgeStep(0.2), 1);
    assert.equal(bridgeStep(0.6), 2);
    assert.equal(bridgeStep(0.85), 2);
    assert.equal(bridgeStep(0.9), 3);
    assert.equal(bridgeStep(1), 3);
  });
});

describe('drain spiral', () => {
  test('accounts rest on the ring, then fall into the centre and vanish', () => {
    const resting = drainPlacement(0, 14, 0.08, 300, 200);
    assert.ok(Math.hypot(resting.x / 300, resting.y / 200) > 0.95, 'on the ring');
    assert.equal(resting.opacity, 1);
    const end = drainPlacement(0, 14, 1, 300, 200);
    assert.ok(Math.abs(end.x) < 0.001 && Math.abs(end.y) < 0.001, 'at the centre');
    assert.equal(end.opacity, 0);
  });

  test('accounts wait for the page: before the drain they are invisible', () => {
    assert.equal(drainPlacement(3, 14, 0, 300, 200).opacity, 0);
  });

  test('later accounts start falling later', () => {
    const first = drainPlacement(0, 14, 0.4, 300, 200);
    const last = drainPlacement(13, 14, 0.4, 300, 200);
    assert.ok(Math.hypot(first.x, first.y) < Math.hypot(last.x, last.y));
  });
});

describe('frame watchdog', () => {
  test('ignores the settling frames, then calls back once per slow window', () => {
    let slow = 0;
    const sample = frameWatchdog(2, 3, 34, () => slow++);
    for (const ms of [500, 500]) sample(ms);
    assert.equal(slow, 0, 'first frames are shader compiles, not the device');
    for (const ms of [40, 40, 40]) sample(ms);
    assert.equal(slow, 1);
    for (const ms of [16, 16, 16]) sample(ms);
    assert.equal(slow, 1, 'a fast window does not fire');
    for (const ms of [50, 50, 50]) sample(ms);
    assert.equal(slow, 2);
  });

  /** Counts the slow windows that the scene's own settings (20 settle frames, windows of 60, 34 ms) see in these frame times. */
  function slowWindows(frames: number[]): number {
    let slow = 0;
    const sample = frameWatchdog(20, 60, 34, () => slow++);
    for (const ms of frames) sample(ms);
    return slow;
  }
  const window60 = (ms: number, longFrame: number): number[] => [...Array.from({ length: 59 }, () => ms), longFrame];

  test('a browser that caps frames at 30 per second is not slow, also with a long frame in every window', () => {
    const settle = Array.from({ length: 20 }, () => 33.4);
    const capped = Array.from({ length: 10 }, () => window60(33.34, 80)).flat();
    assert.equal(slowWindows([...settle, ...capped]), 0, 'energy saver and low power mode draw 30 frames per second');
  });

  test('one frame as long as a sleep says nothing about the GPU', () => {
    const settle = Array.from({ length: 20 }, () => 16.7);
    assert.equal(slowWindows([...settle, ...window60(16.7, 600_000), ...window60(16.7, 16.7)]), 0);
  });

  test('a device that draws 3 frames per second gets its verdict after 2 seconds, not after 60 frames', () => {
    const settle = Array.from({ length: 20 }, () => 300);
    assert.equal(slowWindows([...settle, ...Array.from({ length: 7 }, () => 300)]), 1);
  });

  test('a slow window passes its median on', () => {
    const medians: number[] = [];
    const sample = frameWatchdog(0, 5, 34, (median) => medians.push(median));
    for (const ms of [40, 900, 50, 45, 41]) sample(ms);
    assert.deepEqual(medians, [45]);
  });
});

describe('cheaper picture', () => {
  test('a frame time a little over budget takes a quarter off each side', () => {
    assert.equal(cheaperPixelRatio(1.6, 40, 34, 0.5), 1.6 * 0.75);
  });

  test('a frame time far over budget takes half off each side at once', () => {
    assert.equal(cheaperPixelRatio(1.6, 300, 34, 0.5), 0.8);
  });

  test('the resolution has a floor, and at the floor nothing changes: the scene has no way to stop for speed', () => {
    assert.equal(cheaperPixelRatio(0.6, 300, 34, 0.5), 0.5);
    assert.equal(cheaperPixelRatio(0.5, 3000, 34, 0.5), 0.5);
  });
});

describe('card layout', () => {
  test('people come first in the buffers, so the halo pass can draw only them', () => {
    const field = buildCards(1.6);
    assert.ok(field.people > 0);
    for (let i = 0; i < field.people; i++) assert.equal(field.a[i * 4 + 3], 1, `instance ${i} is a person`);
    for (let i = field.people; i < field.total; i++) assert.equal(field.a[i * 4 + 3], 0, `instance ${i} is slop`);
  });

  test('lanes walk through every slop account before one repeats', () => {
    const field = buildCards(1.6);
    const slots = new Set(field.laneSlot.subarray(0, SLOP.length));
    assert.equal(slots.size, SLOP.length);
  });

  test('every atlas slot is a real line', () => {
    const field = buildCards(1.6);
    for (let i = 0; i < field.total; i++) {
      const slot = field.b[i * 4 + 1]!;
      assert.ok(Number.isInteger(slot) && slot >= 0 && slot < SLOP.length + PEOPLE.length, `slot ${slot}`);
    }
  });

  test('a phone that turns keeps a full flood: upright and on its side it gets the same lanes', () => {
    assert.equal(buildCards(390 / 844).laneCount, buildCards(844 / 390).laneCount);
  });

  test('the layout is the same on every visit', () => {
    assert.deepEqual([...buildCards(1.6).a.slice(0, 40)], [...buildCards(1.6).a.slice(0, 40)]);
    const random = seededRandom(1);
    const values = Array.from({ length: 100 }, random);
    assert.ok(values.every((v) => v >= 0 && v < 1));
    assert.ok(new Set(values).size > 90);
  });

  test('a card stays between the horizon and the camera at any time', () => {
    for (const t of [0, 1, 37.5, 900]) {
      const depth = cardDepth(12, 1.7, t);
      assert.ok(depth <= NEAR_Z && depth >= NEAR_Z - FIELD_LENGTH, `depth ${depth} at t=${t}`);
    }
  });

  test('every fake handle is too long to belong to a real X account', () => {
    for (const line of [...SLOP, ...PEOPLE]) assert.ok(line.handle.length > 15, line.handle);
  });
});

describe('text field', () => {
  const SIZE = 48;
  const NEUTRAL = 128;
  const at = (x: number, y: number) => (x + y * SIZE) * 4;

  function block(): Float32Array<ArrayBuffer> {
    const mask = new Float32Array(SIZE * SIZE);
    for (let y = 18; y < 30; y++) for (let x = 18; x < 30; x++) mask[x + y * SIZE] = 1;
    return mask;
  }

  const fieldWithBlock = (): Uint8Array => encodeField(block(), new Float32Array(SIZE * SIZE), SIZE, SIZE, 1);

  test('far from the words nothing is carved, nothing is pushed and nothing is dimmed', () => {
    const pixels = fieldWithBlock();
    assert.deepEqual([...pixels.subarray(at(2, 2), at(2, 2) + 4)], [0, NEUTRAL, NEUTRAL, 0]);
  });

  test('a pane of glass cuts nothing and pushes nothing: it only marks where the bright cards go dim', () => {
    const pixels = encodeField(new Float32Array(SIZE * SIZE), block(), SIZE, SIZE, 1);
    assert.deepEqual([...pixels.subarray(at(24, 24), at(24, 24) + 4)], [0, NEUTRAL, NEUTRAL, 255], 'the middle of the pane');
    assert.deepEqual([...pixels.subarray(at(16, 24), at(16, 24) + 3)], [0, NEUTRAL, NEUTRAL], 'beside the pane');
    assert.equal(pixels[at(2, 2) + 3], 0, 'far from the pane');
  });

  test('the middle of a word is fully carved', () => {
    assert.equal(fieldWithBlock()[at(24, 24)], 255);
  });

  test('around a word the cards are pushed away from it', () => {
    const pixels = fieldWithBlock();
    assert.ok(pixels[at(16, 24) + 1]! < NEUTRAL, 'left of the word: pushed left');
    assert.ok(pixels[at(31, 24) + 1]! > NEUTRAL, 'right of the word: pushed right');
    assert.ok(pixels[at(24, 16) + 2]! > NEUTRAL, 'above the word: pushed up, clip space runs up');
    assert.ok(pixels[at(24, 31) + 2]! < NEUTRAL, 'below the word: pushed down');
  });
});

describe('browser detection', () => {
  const none = { brave: false, arc: false };
  const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const cases: [string, Parameters<typeof detectBrowser>[0], string][] = [
    ['Chrome', { userAgent: CHROME_MAC, ...none }, 'chrome'],
    ['Edge', { userAgent: `${CHROME_MAC} Edg/130.0.0.0`, ...none }, 'edge'],
    ['Opera', { userAgent: `${CHROME_MAC} OPR/115.0.0.0`, ...none }, 'opera'],
    ['Vivaldi', { userAgent: `${CHROME_MAC} Vivaldi/7.0`, ...none }, 'vivaldi'],
    ['Brave reports a Chrome agent', { userAgent: CHROME_MAC, brave: true, arc: false }, 'brave'],
    ['Arc reports a Chrome agent', { userAgent: CHROME_MAC, brave: false, arc: true }, 'arc'],
    ['Firefox desktop', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', ...none }, 'firefox'],
    ['Firefox Android', { userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0', ...none }, 'firefox-android'],
    ['Safari macOS', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', ...none }, 'safari'],
    ['Safari iPhone', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', ...none }, 'safari'],
    ['Chrome iPhone cannot load extensions', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1', ...none }, 'phone-other'],
    ['Chrome Android cannot load extensions', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', ...none }, 'phone-other'],
    ['anything else', { userAgent: 'curl/8.5.0', ...none }, 'unknown'],
  ];
  for (const [name, signals, expected] of cases) {
    test(name, () => assert.equal(detectBrowser(signals), expected));
  }
});

describe('renderer names', () => {
  for (const name of [
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
    'llvmpipe (LLVM 15.0.7, 256 bits)',
    'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)',
  ]) {
    test(`no GPU behind: ${name}`, () => assert.equal(isSoftwareRenderer(name), true));
  }
  for (const name of [
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Adreno (TM) 642L',
    'Mali-G78',
    'Apple GPU',
  ]) {
    test(`a real GPU: ${name}`, () => assert.equal(isSoftwareRenderer(name), false));
  }
});
