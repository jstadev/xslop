// GLSL for the one scene of the page. Every moving thing is a pure function of time, lane state and scroll progress,
// so the frame loop only sets uniforms and the geometry never changes.

const LANE_STATE = /* glsl */ `
  uniform sampler2D uLanes;

  // Returns cut age and regrow age for one lane at one depth. Negative age means the wave has not reached this depth.
  vec2 laneAges(float lane, float worldZ, float farZ, float wave) {
    vec4 state = texelFetch(uLanes, ivec2(int(lane), 0), 0);
    float cutAge = state.r < 0.0 ? -1.0 : uTime - state.r - abs(worldZ - state.g) / wave;
    float backAge = state.b < 0.0 ? -1.0 : uTime - state.b - (worldZ - farZ) / wave;
    return vec2(cutAge, backAge);
  }
`;

const POSE_COMMON = /* glsl */ `
  uniform float uTime;
  uniform vec3 uField0;    // field length, near z, wave speed
  uniform vec4 uStage;     // morph to galaxy, drain, field strength, river amount
  uniform vec4 uGalaxy;    // separation, radius, vertical squash, swirl speed
  uniform vec2 uAxis;      // the line between the two galaxies: side by side, or one above the other
  uniform sampler2D uField;
  uniform vec3 uFieldView; // view height, field height (css px), scroll y

  float cardWorldZ(float phase, float speed) {
    float z = mod(phase + speed * uTime, uField0.x);
    return z - (uField0.x - uField0.y);
  }

  vec3 floodPosition(vec2 lane, float phase, float speed, float seed) {
    float z = cardWorldZ(phase, speed);
    float sway = sin(uTime * 0.5 + seed * 6.2831) * 0.14;
    float bob = sin(uTime * 1.3 + seed * 12.0) * 0.1;
    return vec3(lane.x + sway, bob, z);
  }

  vec3 galaxyPosition(float side, vec4 seed) {
    float r = pow(seed.y, 1.7) * uGalaxy.y;
    float edge = r / uGalaxy.y;
    float arm = floor(seed.z * 3.0) * 2.0944;
    float jitter = (seed.w - 0.5) * mix(1.7, 0.42, edge);
    float a = (arm + r * 0.62 + jitter + uTime * uGalaxy.w) * side;
    float height = (fract(seed.w * 7.0) - 0.5) * 2.0 * max(0.15, 1.0 - edge) * uGalaxy.y * 0.22;
    vec2 disk = vec2(cos(a) * r, sin(a) * r * uGalaxy.z + height * 0.3);
    return vec3(side * uAxis * uGalaxy.x + disk, height);
  }

  vec3 drainPosition(vec3 galaxy, float e) {
    float r = length(galaxy.xy);
    float a = atan(galaxy.y, galaxy.x) + e * e * 9.0;
    float k = pow(1.0 - e, 1.6);
    return vec3(cos(a) * r * k, sin(a) * r * k * mix(1.0, 0.72, e), galaxy.z * k - e * e * e * 18.0);
  }

  // The field samples in screen space: the cards are pushed away from the words on top of the canvas.
  vec3 fieldAt(vec4 clip) {
    vec2 ndc = clip.xy / clip.w;
    float y = (1.0 - (ndc.y * 0.5 + 0.5)) * uFieldView.x + uFieldView.z;
    vec4 f = textureLod(uField, vec2(ndc.x * 0.5 + 0.5, y / uFieldView.y), 0.0);
    return vec3(f.r, f.gb * 2.0 - 1.0) * vec3(uStage.z, uStage.z, uStage.z);
  }
`;

// The words carve the flood per pixel, so a card that only touches a letter is cut along that letter.
const WORD_MASK = /* glsl */ `
  uniform sampler2D uField;
  uniform vec3 uFieldView;
  uniform vec4 uStage;
  uniform vec2 uResolution;

  vec4 fieldHere() {
    vec2 screen = gl_FragCoord.xy / uResolution;
    float pageY = (1.0 - screen.y) * uFieldView.x + uFieldView.z;
    return texture(uField, vec2(screen.x, pageY / uFieldView.y)) * uStage.z;
  }

  float wordMask(vec4 field) {
    // A hard edge, not a fade: one pixel of antialiasing at the outline.
    float edge = max(fwidth(field.r), 1e-4);
    return smoothstep(0.5 - edge, 0.5 + edge, field.r);
  }

  // A pane of glass cuts nothing: the flood runs under it. Only the bright cards (the people, their halos and a card that
  // burns away) go dim there, so the text on the glass keeps its contrast. The dimming is full at the edge of the pane and
  // fades out around it.
  float glassDim(vec4 field) {
    return 1.0 - 0.8 * min(1.0, field.a * 2.0);
  }
`;

export const CARD_VERTEX = /* glsl */ `
  precision highp float;
  ${POSE_COMMON}
  ${LANE_STATE}
  uniform float uHover;
  uniform vec2 uCardSize;
  uniform float uPush;

  attribute vec4 aA;   // lane x, lane index, phase, kind (0 slop, 1 person)
  attribute vec4 aB;   // speed, slot, seed, seed
  attribute vec4 aSeed;

  out vec2 vLocal;
  out vec2 vHalf;
  out vec2 vUv;
  out float vSlot;
  out float vKind;
  out float vFog;
  out float vMorph;
  out float vDissolve;
  out float vHover;
  out float vSeed;

  void main() {
    float morphStart = aSeed.x * 0.4;
    float morph = clamp((uStage.x * 1.4 - morphStart) / (1.0 - morphStart * 0.5), 0.0, 1.0);
    morph = morph * morph * (3.0 - 2.0 * morph);

    float drain = clamp(uStage.y * 1.5 - aSeed.y * 0.5, 0.0, 1.0);

    vec3 flood = floodPosition(vec2(aA.x, aA.y), aA.z, aB.x, aB.z);
    float side = mod(aA.y, 2.0) < 1.0 ? -1.0 : 1.0;
    vec3 galaxy = galaxyPosition(side, aSeed);
    vec3 center = mix(flood, drain > 0.0 ? drainPosition(galaxy, drain) : galaxy, morph);

    float kind = aA.w;
    float dissolve = 0.0;
    float scaleCut = 1.0;
    if (kind < 0.5) {
      vec2 ages = laneAges(aA.y, flood.z, uField0.y - uField0.x, uField0.z);
      float restored = step(0.0, ages.y) * smoothstep(0.0, 0.5, ages.y);
      float cut = step(0.0, ages.x) * clamp(ages.x / 0.34, 0.0, 1.0);
      // A regrown lane shows its cards again; a morphing scene always restores the lanes.
      float cutWeight = (1.0 - smoothstep(0.08, 0.34, uStage.x));
      if (ages.y >= 0.0) { dissolve = (1.0 - restored); }
      else { dissolve = cut; }
      dissolve *= cutWeight;
      scaleCut = 1.0 + 0.25 * dissolve;
    }

    vec2 cardSize = uCardSize * mix(1.0, 0.03 + aSeed.z * 0.05, morph) * scaleCut;
    float point = mix(0.0, 0.075 + aSeed.w * 0.11, morph) * (1.0 - smoothstep(0.86, 1.0, drain));
    vec2 size = mix(cardSize, vec2(point), morph);

    vec4 view = viewMatrix * vec4(center, 1.0);
    vec4 clip = projectionMatrix * view;

    vec3 field = fieldAt(clip);
    clip.xy += field.yz * uPush * clip.w;

    gl_Position = clip;
    gl_Position.x += projectionMatrix[0][0] * position.x * size.x;
    gl_Position.y += projectionMatrix[1][1] * position.y * size.y;

    vLocal = position.xy * 2.0;
    vHalf = size * 0.5;
    vUv = vec2(uv.x, 1.0 - uv.y);
    vSlot = aB.y;
    vKind = kind;
    float dist = length(view.xyz);
    vFog = smoothstep(uField0.x * mix(0.66, 0.95, uStage.w), mix(14.0, 62.0, uStage.w), dist);
    vMorph = morph;
    vDissolve = dissolve;
    vHover = abs(float(gl_InstanceID) - uHover) < 0.5 ? 1.0 : 0.0;
    vSeed = aSeed.y;
  }
`;

export const CARD_FRAGMENT = /* glsl */ `
  precision highp float;
  ${WORD_MASK}
  uniform sampler2D uAtlas;
  uniform vec3 uBg;
  uniform vec3 uCardFill;
  uniform vec3 uCardBorder;
  uniform vec3 uCardText;
  uniform vec3 uCardMuted;
  uniform vec3 uPersonFill;
  uniform vec3 uPersonText;
  uniform vec3 uAccent;
  uniform float uAtlasRows;
  uniform float uAtlasColumns;

  in vec2 vLocal;
  in vec2 vHalf;
  in vec2 vUv;
  in float vSlot;
  in float vKind;
  in float vFog;
  in float vMorph;
  in float vDissolve;
  in float vHover;
  in float vSeed;

  layout(location = 0) out vec4 outColor;

  float sdRoundBox(vec2 p, vec2 half_size, float r) {
    vec2 d = abs(p) - half_size + r;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
  }

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    vec2 p = vLocal * vHalf;
    float radius = mix(0.14, min(vHalf.x, vHalf.y), vMorph);
    float d = sdRoundBox(p, vHalf, radius);
    if (d > 0.0) discard;

    if (vDissolve > 0.0 && hash(floor(vUv * vec2(42.0, 14.0)) + vSeed) < vDissolve) discard;
    // With the slop gone, a far card would be a black hole in the horizon's glow. It thins out instead.
    if (vKind > 0.5 && vMorph < 0.98 && hash(gl_FragCoord.xy) > vFog * 6.0) discard;

    vec3 color;
    if (vMorph >= 0.98) {
      color = mix(uPersonFill, uCardText, vSeed);
    } else {
      float slot = vSlot;
      float slotX = mod(slot, uAtlasColumns);
      float slotY = floor(slot / uAtlasColumns);
      vec2 atlasUv = vec2((slotX + vUv.x) / uAtlasColumns, (slotY + vUv.y) / uAtlasRows);
      vec4 glyph = texture(uAtlas, atlasUv);

      bool person = vKind > 0.5;
      vec3 fill = person ? uPersonFill : uCardFill;
      vec3 line = person ? uPersonFill : uCardBorder;
      vec3 text = person ? uPersonText : uCardText;
      vec3 muted = person ? uPersonText : uCardMuted;

      float border = smoothstep(-0.05, -0.02, d);
      color = mix(fill, line, border);
      color = mix(color, text, glyph.r);
      color = mix(color, muted, glyph.g * 0.9);

      // Avatar: a filled dot where the portrait sits on X.
      vec2 cardPoint = p + vec2(vHalf.x - 0.52, -0.1);
      float avatar = smoothstep(0.34, 0.32, length(cardPoint));
      color = mix(color, person ? uPersonText : uCardBorder, avatar);

      // The x, top right. The hovered card lights it in the brand color.
      vec2 xPoint = (p - vec2(vHalf.x - 0.34, vHalf.y - 0.34)) / 0.2;
      if (!person) {
        float cross = min(abs(xPoint.x - xPoint.y), abs(xPoint.x + xPoint.y));
        float stroke = smoothstep(0.32, 0.18, cross) * smoothstep(1.12, 0.98, max(abs(xPoint.x), abs(xPoint.y)));
        float ring = smoothstep(1.42, 1.3, length(xPoint)) * vHover;
        color = mix(color, uAccent, ring);
        color = mix(color, vHover > 0.5 ? uBg : uCardMuted, stroke);
      }

      // The dissolve eats the card from an edge of the brand color.
      if (vDissolve > 0.0) color = mix(color, uAccent, smoothstep(0.1, 0.9, vDissolve));
      color = mix(color, uAccent, vHover * 0.08);
    }

    // The flood is 10% less opaque than a full card; the cards that turn into stars keep their full light.
    float floodOpacity = mix(0.9, 1.0, vMorph);
    vec4 field = fieldHere();
    float shown = vFog * floodOpacity * (1.0 - wordMask(field));
    if (vKind > 0.5 || vDissolve > 0.0) shown *= glassDim(field);
    outColor = vec4(mix(uBg, color, shown), 1.0);
  }
`;

export const HALO_VERTEX = /* glsl */ `
  precision highp float;
  ${POSE_COMMON}
  uniform vec2 uCardSize;
  uniform float uPush;
  attribute vec4 aA;
  attribute vec4 aB;
  attribute vec4 aSeed;
  out vec2 vLocal;
  out float vStrength;

  void main() {
    float morphStart = aSeed.x * 0.4;
    float morph = clamp((uStage.x * 1.4 - morphStart) / (1.0 - morphStart * 0.5), 0.0, 1.0);
    vec3 flood = floodPosition(vec2(aA.x, aA.y), aA.z, aB.x, aB.z);
    float side = mod(aA.y, 2.0) < 1.0 ? -1.0 : 1.0;
    vec3 center = mix(flood, galaxyPosition(side, aSeed), morph * morph * (3.0 - 2.0 * morph));
    vec2 size = uCardSize * 1.55;

    vec4 view = viewMatrix * vec4(center, 1.0);
    vec4 clip = projectionMatrix * view;
    vec3 field = fieldAt(clip);
    clip.xy += field.yz * uPush * clip.w;
    gl_Position = clip;
    gl_Position.x += projectionMatrix[0][0] * position.x * size.x;
    gl_Position.y += projectionMatrix[1][1] * position.y * size.y;
    vLocal = position.xy * 2.0 * vec2(size.x / uCardSize.x, size.y / uCardSize.y);

    float dist = length(view.xyz);
    float fog = smoothstep(uField0.x * 0.5, 16.0, dist);
    vStrength = (1.0 - morph) * fog;
  }
`;

export const HALO_FRAGMENT = /* glsl */ `
  precision highp float;
  ${WORD_MASK}
  uniform vec3 uHalo;
  in vec2 vLocal;
  in float vStrength;
  layout(location = 0) out vec4 outColor;

  void main() {
    float d = max(length(max(abs(vLocal) - vec2(1.0), 0.0)), 0.0);
    float glow = smoothstep(0.55, 0.0, d);
    vec4 field = fieldHere();
    float alpha = glow * vStrength * 0.55 * (1.0 - wordMask(field)) * glassDim(field);
    if (alpha <= 0.004) discard;
    outColor = vec4(uHalo * alpha, alpha);
  }
`;

export const SPARK_VERTEX = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform vec3 uField0;
  uniform float uPixel;
  uniform vec4 uStage;
  ${LANE_STATE}

  attribute vec4 aS;   // lane x, lane index, depth, speed
  attribute vec3 aDir;
  out float vLife;

  void main() {
    float z = aS.z;
    vec2 ages = laneAges(aS.y, z, uField0.y - uField0.x, uField0.z);
    float t = ages.x;
    float life = (t < 0.0 || t > 0.9 || uStage.x > 0.4) ? 0.0 : 1.0 - t / 0.9;
    vec3 p = vec3(aS.x, 0.0, z) + aDir * t * aS.w;
    p.y -= t * t * 1.6;
    vec4 view = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * view;
    gl_PointSize = (life <= 0.0 ? 0.0 : mix(1.5, 7.0 * (0.4 + life), life)) * uPixel * 28.0 / max(1.0, -view.z);
    vLife = life;
  }
`;

export const SPARK_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec3 uAccent;
  in float vLife;
  layout(location = 0) out vec4 outColor;

  void main() {
    if (vLife <= 0.0) discard;
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float a = (1.0 - d) * vLife;
    outColor = vec4(mix(uAccent, vec3(1.0), vLife * vLife * 0.5) * a, a);
  }
`;

// Bridge: one rater's vote is a thin thread from the galaxy to the account in the middle.
export const VOTE_VERTEX = /* glsl */ `
  precision highp float;
  uniform float uBridge;
  uniform float uAspect;
  uniform float uLineWidth;
  uniform float uFade;
  uniform vec4 uGalaxy;
  uniform vec2 uAxis;
  attribute vec4 aFrom;    // side, then the offset inside that galaxy
  attribute float aStart;
  out float vAlong;
  out float vReach;
  out float vFade;

  void main() {
    vec3 origin = vec3(aFrom.x * uAxis * uGalaxy.x, 0.0) + aFrom.yzw;
    vec4 a = projectionMatrix * viewMatrix * vec4(origin, 1.0);
    vec4 b = projectionMatrix * viewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec2 sa = a.xy / a.w * vec2(uAspect, 1.0);
    vec2 sb = b.xy / b.w * vec2(uAspect, 1.0);
    vec2 dir = normalize(sb - sa);
    vec2 normal = vec2(-dir.y, dir.x);
    vec4 from = mix(a, b, position.x + 0.5);
    from.xy += normal * vec2(1.0 / uAspect, 1.0) * position.y * uLineWidth * from.w;
    gl_Position = from;
    vAlong = position.x + 0.5;
    vReach = clamp((uBridge - aStart) / 0.09, 0.0, 1.0);
    vFade = uFade;
  }
`;

export const VOTE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec3 uVote;
  in float vAlong;
  in float vReach;
  in float vFade;
  layout(location = 0) out vec4 outColor;

  void main() {
    if (vAlong > vReach) discard;
    float a = smoothstep(0.0, 0.1, vAlong) * smoothstep(vReach, vReach - 0.1, vAlong) * vFade * 0.7;
    if (a <= 0.003) discard;
    outColor = vec4(uVote * a, a);
  }
`;

// The bridge: one line of light across the gap. It exists only when both sides have marked the account.
export const BEAM_VERTEX = /* glsl */ `
  precision highp float;
  uniform vec4 uGalaxy;
  uniform vec2 uAxis;
  uniform float uHalfWidth;
  uniform float uAspect;
  out vec2 vUvBeam;

  void main() {
    vec2 along = uAxis * uGalaxy.x * position.x * 2.0;
    vec4 clip = projectionMatrix * viewMatrix * vec4(along, 0.0, 1.0);
    clip.xy += vec2(-uAxis.y / uAspect, uAxis.x) * position.y * uHalfWidth * clip.w;
    gl_Position = clip;
    vUvBeam = vec2(position.x + 0.5, position.y * 2.0);
  }
`;

export const BEAM_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec3 uAccent;
  uniform float uLit;
  uniform float uTime;
  in vec2 vUvBeam;
  layout(location = 0) out vec4 outColor;

  void main() {
    float gx = uLit;
    float front = smoothstep(gx, gx - 0.25, abs(vUvBeam.x - 0.5) * 2.0);
    float along = smoothstep(0.0, 0.08, vUvBeam.x) * smoothstep(1.0, 0.92, vUvBeam.x);
    float core = smoothstep(0.08, 0.0, abs(vUvBeam.y));
    float glow = smoothstep(1.0, 0.0, abs(vUvBeam.y));
    float travel = 0.72 + 0.28 * sin(vUvBeam.x * 24.0 - uTime * 7.0);
    float intensity = (core * 2.4 + glow * glow * 0.7 * travel) * front * along;
    if (intensity <= 0.005) discard;
    vec3 color = mix(uAccent, vec3(1.0), core * 0.75);
    outColor = vec4(color * intensity, intensity);
  }
`;

export const GLOW_VERTEX = /* glsl */ `
  precision highp float;
  uniform vec3 uGlowCenter;
  uniform vec2 uGlowSize;
  out vec2 vUvGlow;

  void main() {
    vec4 view = viewMatrix * vec4(uGlowCenter, 1.0);
    view.x += position.x * uGlowSize.x;
    view.y += position.y * uGlowSize.y;
    gl_Position = projectionMatrix * view;
    vUvGlow = position.xy * 2.0;
  }
`;

export const GLOW_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec3 uGlowColor;
  uniform float uGlowStrength;
  in vec2 vUvGlow;
  layout(location = 0) out vec4 outColor;

  void main() {
    float d = length(vUvGlow);
    float a = pow(max(0.0, 1.0 - d), 2.2) * uGlowStrength;
    if (a <= 0.003) discard;
    outColor = vec4(uGlowColor * a, a);
  }
`;

export const MARK_VERTEX = /* glsl */ `
  precision highp float;
  out vec3 vNormalW;

  void main() {
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  }
`;

export const MARK_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec3 uAccent;
  uniform vec3 uBg;
  in vec3 vNormalW;
  layout(location = 0) out vec4 outColor;

  void main() {
    float rim = pow(1.0 - abs(normalize(vNormalW).z), 1.5);
    // The face stays nearly black. The light lives on the edges and in the hole.
    outColor = vec4(mix(mix(uBg, uAccent, 0.08), uAccent, rim), 1.0);
  }
`;
