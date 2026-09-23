// The board, in three dimensions.
//
// The flat board is a CSS grid of forty buttons and it is a perfectly good way
// to read a game: you can see every price at once and a screen reader can walk
// it. What it cannot do is make anything *happen*. Every snapshot rebuilds it,
// so a token does not travel — it is simply somewhere else than it was a moment
// ago, and the eleven squares it crossed never existed. Nobody looks up from
// their phone for that.
//
// So this is the other board. The same forty squares, extruded, with a token
// that hops from one to the next while everybody watches, dice that are thrown
// into the middle and tumble to a stop, and houses that go up. It is the same
// game state, drawn by something that can hold a position between two frames.
//
// It is additive, and it says so: `client/monopoly.js` keeps the flat board and
// switches between them. A browser with no WebGL, a player who has turned motion
// off, a phone that would rather not — all of them get the grid, unchanged.
//
// Nothing here is fetched. three.js is committed under `client/vendor/`, the
// pictures are the same hand-written SVG the flat board uses, painted into
// canvases, and the only text is drawn with the fonts already on the machine.

import { blip, motionWanted, noise } from "./audio.js";
import { hueFor } from "./views.js";
import { formatMoney, ringPosition } from "/shared/monopoly.js";
import { sceneSvg } from "/shared/monopoly_art.js";

// ---------------------------------------------------------------------------
// Sizes
//
// One tile is one unit. Everything else is a fraction of a tile, so a board of
// a different square count scales without a second table of numbers.
// ---------------------------------------------------------------------------

const TILE = 1;
const TILE_GAP = 0.04;
const TILE_HEIGHT = 0.16;
const BASE_DROP = 0.14;
/** How far a pawn stands above the tile it is on. */
const PAWN_LIFT = TILE_HEIGHT;
const PAWN_HEIGHT = 0.62;
const DIE_SIZE = 0.92;

/** One step of a walk, in milliseconds. Slow enough to follow, brisk enough to sit through. */
const HOP_MS = 165;
/** A throw, from leaving the hand to sitting still. */
const THROW_MS = 1150;

// ---------------------------------------------------------------------------
// Loading three.js
// ---------------------------------------------------------------------------

/** @type {object | null} The library, once it has arrived. */
let THREE = null;
/** @type {Promise<object> | null} The in-flight import, so two boards do not fetch it twice. */
let arriving = null;

/**
 * Is there a GPU here worth talking to?
 *
 * Asked before anything is imported: on a machine that answers no, the three
 * quarters of a megabyte never leave the disk. The test context is thrown away
 * immediately — some browsers cap how many live at once and this one is only
 * ever a question.
 */
export function webglOk() {
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") ?? probe.getContext("webgl");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

async function library() {
  if (THREE) return THREE;
  if (!arriving) arriving = import("/client/vendor/three.module.min.js");
  THREE = await arriving;
  return THREE;
}

// ---------------------------------------------------------------------------
// Painting textures
//
// Every face of every tile is a canvas. Drawing them by hand rather than
// loading images keeps the "nothing comes off the network" rule intact and, more
// usefully, means a square's picture on the 3D board is the same drawing as on
// the flat one — the same `sceneSvg`, painted instead of inlined.
// ---------------------------------------------------------------------------

const PX = 256;

/** @type {Map<string, HTMLImageElement>} Scene name to a loaded (or loading) image. */
const artCache = new Map();

/**
 * The scene drawing, as an image.
 *
 * SVG in an `<img>` is same-origin-clean and never taints a canvas, which is
 * what lets these become textures. The promise resolves to null rather than
 * rejecting: a picture that will not decode should cost a plain-coloured tile,
 * not a board that fails to build.
 */
function artImage(key) {
  if (artCache.has(key)) return artCache.get(key);
  const svg = sceneSvg(key, "slice");
  const img = new Image();
  const done = new Promise((resolve) => {
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
  });
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const entry = done;
  artCache.set(key, entry);
  return entry;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/**
 * Text that has to fit, whatever somebody called their street.
 *
 * Shrinks the type until the longest word fits, then wraps — in that order,
 * because a board written in Vietnamese has words like "Thành" that must not be
 * broken and place names that happily run to four of them.
 */
function fitText(g, text, width, maxLines, startSize, weight = "600") {
  let size = startSize;
  for (;;) {
    g.font = `${weight} ${size}px system-ui, "Segoe UI", sans-serif`;
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (g.measureText(next).width <= width || !line) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    const longest = Math.max(...lines.map((l) => g.measureText(l).width));
    if ((lines.length <= maxLines && longest <= width) || size <= 11) return { lines, size };
    size -= 1;
  }
}

/**
 * One square's top face.
 *
 * Painted the way the flat board reads: the group's colour along the outer edge,
 * the picture behind, the name and the price over a scrim so they stay legible
 * whatever the drawing underneath is doing.
 */
function paintTile(space, group, theme, unit) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = PX;
  const g = canvas.getContext("2d");

  const draw = (art) => {
    g.clearRect(0, 0, PX, PX);
    g.fillStyle = theme.tile;
    g.fillRect(0, 0, PX, PX);

    if (art) {
      g.save();
      g.globalAlpha = 0.95;
      // The drawing is 5:3 and the tile is square: crop to the middle rather
      // than squash, which is exactly what `slice` does on the flat board.
      const scale = Math.max(PX / 100, PX / 60);
      const w = 100 * scale;
      const h = 60 * scale;
      g.drawImage(art, (PX - w) / 2, (PX - h) / 2, w, h);
      g.restore();
    }

    // The band, along the edge that faces out of the board.
    if (group) {
      g.fillStyle = group.color;
      g.fillRect(0, 0, PX, PX * 0.17);
      g.fillStyle = "rgba(0,0,0,0.16)";
      g.fillRect(0, PX * 0.17 - 3, PX, 3);
    }

    // A scrim under the words. Without it a pale sky and a white name are the
    // same colour and the square has no name at all.
    const scrim = g.createLinearGradient(0, PX * 0.52, 0, PX);
    scrim.addColorStop(0, "rgba(0,0,0,0)");
    scrim.addColorStop(0.45, theme.scrimSoft);
    scrim.addColorStop(1, theme.scrim);
    g.fillStyle = scrim;
    g.fillRect(0, PX * 0.5, PX, PX * 0.5);

    g.textAlign = "center";
    g.fillStyle = theme.ink;
    const { lines, size } = fitText(g, space.name, PX * 0.88, 2, 34);
    let y = space.price === undefined ? PX * 0.86 : PX * 0.79;
    y -= (lines.length - 1) * size * 1.05;
    for (const line of lines) {
      g.fillText(line, PX / 2, y);
      y += size * 1.05;
    }

    if (space.price !== undefined) {
      g.font = "700 28px system-ui, sans-serif";
      g.fillStyle = theme.inkDim;
      g.fillText(formatMoney(space.price, unit), PX / 2, PX * 0.94);
    }

    // The icon, up under the band where the picture is least busy.
    g.font = "34px system-ui, sans-serif";
    g.fillStyle = theme.ink;
    g.fillText(space.icon ?? "", PX / 2, PX * 0.36);
  };

  draw(null);
  const texture = { canvas, redraw: draw };
  artImage(space.scene).then((art) => {
    if (art) {
      draw(art);
      texture.dirty?.();
    }
  });
  return texture;
}

/** The die faces, once, shared by both dice. */
function paintPips(theme) {
  const spots = {
    1: [[0.5, 0.5]],
    2: [[0.28, 0.28], [0.72, 0.72]],
    3: [[0.26, 0.26], [0.5, 0.5], [0.74, 0.74]],
    4: [[0.28, 0.28], [0.72, 0.28], [0.28, 0.72], [0.72, 0.72]],
    5: [[0.26, 0.26], [0.74, 0.26], [0.5, 0.5], [0.26, 0.74], [0.74, 0.74]],
    6: [[0.28, 0.24], [0.72, 0.24], [0.28, 0.5], [0.72, 0.5], [0.28, 0.76], [0.72, 0.76]],
  };
  return Object.entries(spots).map(([face, pips]) => {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const g = canvas.getContext("2d");
    g.fillStyle = theme.die;
    roundRect(g, 2, 2, size - 4, size - 4, 22);
    g.fill();
    g.fillStyle = theme.diePip;
    for (const [x, y] of pips) {
      g.beginPath();
      g.arc(x * size, y * size, size * 0.085, 0, Math.PI * 2);
      g.fill();
    }
    return { face: Number(face), canvas };
  });
}

/**
 * A player's badge: their colour, their piece and their name.
 *
 * This is the answer to "whose is that". The flat board shows a shared emoji —
 * a scooter, a dragon — which tells you which *seat* is there but not who. The
 * hue is the one the feed and the players list already use for that person, so
 * the colour you have been reading their messages in is the colour standing on
 * Tràng Tiền.
 */
function paintBadge(player, hue, theme) {
  const w = 320;
  const h = 96;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, w, h);

  g.fillStyle = `hsl(${hue} 62% ${theme.dark ? "34%" : "52%"})`;
  roundRect(g, 4, 12, w - 8, h - 24, (h - 24) / 2);
  g.fill();
  g.strokeStyle = theme.dark ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.8)";
  g.lineWidth = 3;
  g.stroke();

  g.textAlign = "left";
  g.textBaseline = "middle";
  g.font = "38px system-ui, sans-serif";
  g.fillText(player.token, 22, h / 2 + 1);

  g.fillStyle = "#fff";
  const { lines, size } = fitText(g, player.name, w - 96, 1, 34, "700");
  g.font = `700 ${size}px system-ui, "Segoe UI", sans-serif`;
  g.fillText(lines[0] ?? "", 74, h / 2 + 1);

  return canvas;
}

/** The emblem for the middle: the board's own picture, laid into the felt. */
function paintCentre(mono, theme) {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d");
  const draw = (art) => {
    g.clearRect(0, 0, size, size);
    g.fillStyle = theme.felt;
    g.fillRect(0, 0, size, size);
    if (art) {
      g.save();
      g.globalAlpha = theme.dark ? 0.34 : 0.42;
      const scale = Math.min(size / 100, size / 60) * 0.92;
      const w = 100 * scale;
      const h = 60 * scale;
      g.drawImage(art, (size - w) / 2, (size - h) / 2, w, h);
      g.restore();
    }
    g.textAlign = "center";
    g.fillStyle = theme.ink;
    g.font = "700 34px system-ui, sans-serif";
    g.fillText(`${mono.map.icon} ${mono.map.name}`, size / 2, size * 0.14);
  };
  draw(null);
  const out = { canvas, redraw: draw };
  artImage(mono.map.scene || "dothi").then((art) => {
    if (art) {
      draw(art);
      out.dirty?.();
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

/**
 * Everything the scene holds, or null before the first board is built.
 *
 * One object rather than a dozen module-level lets, because tearing a board down
 * is then one assignment and there is no chance of a stale renderer outliving
 * the scene it drew.
 */
let world = null;

/** The element the canvas lives in. Created once and re-parented, never rebuilt. */
let host = null;

/**
 * The board's home in the page.
 *
 * Handed to `client/monopoly.js` to drop into the stage on every snapshot. The
 * stage is emptied and refilled constantly; moving a node between parents keeps
 * its canvas and, crucially, its WebGL context — rebuilding the element would
 * throw away the scene sixty times a game.
 */
export function boardHost() {
  if (!host) {
    host = document.createElement("div");
    host.className = "mono-3d";
    host.setAttribute("role", "img");
  }
  return host;
}

function themeColours() {
  const css = getComputedStyle(document.documentElement);
  const dark = document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme &&
      globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const pick = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    dark,
    sky: pick("--bg", dark ? "#14181d" : "#f3efe7"),
    felt: dark ? "#1d2530" : "#e7e0d2",
    tile: dark ? "#232b36" : "#fbf8f2",
    edge: dark ? "#161c24" : "#d9d2c4",
    ink: dark ? "#e9edf3" : "#22262c",
    inkDim: dark ? "#a7b0bd" : "#5d646e",
    scrim: dark ? "rgba(16,20,26,0.88)" : "rgba(255,255,255,0.9)",
    scrimSoft: dark ? "rgba(16,20,26,0.45)" : "rgba(255,255,255,0.5)",
    die: dark ? "#eef2f7" : "#ffffff",
    diePip: "#1b2027",
  };
}

/**
 * A die, as six faces on six sides of a cube.
 *
 * `AXES` is the order `BoxGeometry` takes its materials in, and `DIE_FACES` says
 * which number is painted on each. Both the painting and the landing read from
 * this one pair, which is the point: the first version of this had the numbers in
 * one list and a hand-derived table of rotations in another, and it landed a
 * three showing five. Opposite faces still sum to seven, as on a real die.
 */
const AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const DIE_FACES = [1, 6, 2, 5, 3, 4];

/**
 * The rotation that brings `face` to the top.
 *
 * Derived rather than tabulated: take the direction that face points in when the
 * die is unrotated, and ask for the rotation that turns it into "up". There is
 * no arithmetic here to get wrong.
 */
function faceUp(T, face) {
  const axis = AXES[Math.max(0, DIE_FACES.indexOf(face))];
  return new T.Quaternion().setFromUnitVectors(
    new T.Vector3(axis[0], axis[1], axis[2]),
    new T.Vector3(0, 1, 0),
  );
}

/**
 * The same, spun by a random amount about the vertical.
 *
 * A die that lands square to the board every time looks placed. Spinning about
 * "up" cannot change which face is up, so the number is still exactly the one
 * the server rolled.
 */
function faceUpTurned(T, face) {
  const spin = new T.Quaternion().setFromAxisAngle(
    new T.Vector3(0, 1, 0),
    Math.random() * Math.PI * 2,
  );
  return spin.multiply(faceUp(T, face));
}

/**
 * How far back the camera has to stand to hold the whole board.
 *
 * Worked out from the board's size and the lens rather than guessed at, because
 * a board with a different square count is a different size and a number tuned
 * against the 40-square one would cut its corners off.
 */
function span(side) {
  const half = (side * TILE + 0.6) / 2;
  // Multiplied by less than one because the camera looks down at the board: the
  // tilt foreshortens it, so a distance that would frame it edge-on leaves it
  // sitting in the middle of a lot of empty felt.
  return (half / Math.tan((38 * Math.PI / 180) / 2)) * 1.06;
}

/** Where square `i` stands in the world. */
function squarePlace(i, total) {
  const side = (total + 4) / 4;
  const { row, col } = ringPosition(i, total);
  const half = (side - 1) / 2;
  return { x: (col - 1 - half) * TILE, z: (row - 1 - half) * TILE, row, col, side };
}

/** Which way a square faces, so its name reads from outside the board. */
function squareTurn(row, col, side) {
  if (row === side) return 0;
  if (col === 1) return -Math.PI / 2;
  if (row === 1) return Math.PI;
  return Math.PI / 2;
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

async function build(ctx, mono) {
  const T = await library();
  const theme = themeColours();
  const total = mono.spaces.length;
  const side = (total + 4) / 4;

  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap is deprecated as of three 0.185 and falls back to this one
  // with a console warning; asked for directly, it is the same shadows quietly.
  renderer.shadowMap.type = T.PCFShadowMap;
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.touchAction = "none";
  boardHost().appendChild(renderer.domElement);

  const scene = new T.Scene();

  // Light: one warm key with a shadow, one cool fill from below the horizon. A
  // board with a single overhead light looks like a spreadsheet.
  const key = new T.DirectionalLight(0xffffff, 2.1);
  key.position.set(5.5, 11, 6.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 40;
  key.shadow.camera.left = -10;
  key.shadow.camera.right = 10;
  key.shadow.camera.top = 10;
  key.shadow.camera.bottom = -10;
  key.shadow.bias = -0.0008;
  scene.add(key);
  scene.add(new T.HemisphereLight(0xffffff, theme.dark ? 0x223044 : 0xbfae94, 1.5));

  const camera = new T.PerspectiveCamera(38, 1, 0.5, 120);

  // The felt, with the board's emblem laid into it.
  const centre = paintCentre(mono, theme);
  const centreTex = new T.CanvasTexture(centre.canvas);
  centreTex.colorSpace = T.SRGBColorSpace;
  centre.dirty = () => (centreTex.needsUpdate = true);
  const feltSize = (side - 2) * TILE;
  const felt = new T.Mesh(
    new T.BoxGeometry(feltSize, BASE_DROP, feltSize),
    [
      new T.MeshStandardMaterial({ color: theme.edge, roughness: 0.9 }),
      new T.MeshStandardMaterial({ color: theme.edge, roughness: 0.9 }),
      new T.MeshStandardMaterial({ map: centreTex, roughness: 0.85 }),
      new T.MeshStandardMaterial({ color: theme.edge, roughness: 0.9 }),
      new T.MeshStandardMaterial({ color: theme.edge, roughness: 0.9 }),
      new T.MeshStandardMaterial({ color: theme.edge, roughness: 0.9 }),
    ],
  );
  felt.position.y = BASE_DROP / 2;
  felt.receiveShadow = true;
  scene.add(felt);

  // The rim the tiles sit on, so the board reads as one object rather than forty.
  const rim = new T.Mesh(
    new T.BoxGeometry(side * TILE + 0.5, BASE_DROP, side * TILE + 0.5),
    new T.MeshStandardMaterial({ color: theme.edge, roughness: 0.95 }),
  );
  rim.position.y = BASE_DROP / 2 - 0.02;
  rim.receiveShadow = true;
  scene.add(rim);

  // --- the squares ---------------------------------------------------------

  const tileGeo = new T.BoxGeometry(TILE - TILE_GAP, TILE_HEIGHT, TILE - TILE_GAP);
  const tiles = mono.spaces.map((space) => {
    const group = mono.map.groups.find((g) => g.id === space.group);
    const art = paintTile(space, group, theme, mono.map.money.unit);
    const tex = new T.CanvasTexture(art.canvas);
    tex.colorSpace = T.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy?.() ?? 1;
    art.dirty = () => (tex.needsUpdate = true);

    const sideMat = new T.MeshStandardMaterial({ color: theme.tile, roughness: 0.8 });
    const mesh = new T.Mesh(tileGeo, [
      sideMat,
      sideMat,
      new T.MeshStandardMaterial({ map: tex, roughness: 0.7 }),
      sideMat,
      sideMat,
      sideMat,
    ]);
    const at = squarePlace(space.i, total);
    mesh.position.set(at.x, BASE_DROP + TILE_HEIGHT / 2, at.z);
    mesh.rotation.y = squareTurn(at.row, at.col, side);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.index = space.i;
    scene.add(mesh);

    const buildings = new T.Group();
    buildings.position.set(at.x, BASE_DROP + TILE_HEIGHT, at.z);
    buildings.rotation.y = mesh.rotation.y;
    scene.add(buildings);

    return {
      space,
      mesh,
      sideMat,
      buildings,
      at,
      art,
      tex,
      /** Resting height. Owned squares stand a little taller than the rest. */
      baseY: BASE_DROP + TILE_HEIGHT / 2,
      level: 0,
      ownerId: null,
      mortgaged: false,
    };
  });

  // --- the pieces ----------------------------------------------------------

  const houseGeo = new T.BoxGeometry(0.17, 0.15, 0.17);
  const roofGeo = new T.ConeGeometry(0.14, 0.12, 4);
  const hotelGeo = new T.BoxGeometry(0.42, 0.2, 0.2);
  const houseMat = new T.MeshStandardMaterial({ color: 0x3f9e5a, roughness: 0.6 });
  const roofMat = new T.MeshStandardMaterial({ color: 0x2c7b44, roughness: 0.6 });
  const hotelMat = new T.MeshStandardMaterial({ color: 0xcc4335, roughness: 0.6 });

  // --- the dice ------------------------------------------------------------

  const pips = paintPips(theme);
  const dieMats = DIE_FACES.map((face) => {
    const canvas = pips.find((p) => p.face === face).canvas;
    const tex = new T.CanvasTexture(canvas);
    tex.colorSpace = T.SRGBColorSpace;
    return new T.MeshStandardMaterial({ map: tex, roughness: 0.35, metalness: 0.02 });
  });
  const dieGeo = new T.BoxGeometry(DIE_SIZE, DIE_SIZE, DIE_SIZE);
  const dice = [0, 1].map(() => {
    const mesh = new T.Mesh(dieGeo, dieMats);
    mesh.castShadow = true;
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  });

  // The ring that goes out from where the dice land: the "something happened"
  // everybody at the table sees without looking at the feed.
  const pulse = new T.Mesh(
    new T.RingGeometry(0.6, 0.78, 48),
    new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: T.DoubleSide }),
  );
  pulse.rotation.x = -Math.PI / 2;
  pulse.position.y = BASE_DROP + TILE_HEIGHT + 0.02;
  scene.add(pulse);

  world = {
    T,
    theme,
    renderer,
    scene,
    camera,
    key,
    total,
    side,
    tiles,
    dice,
    pulse,
    pawns: new Map(),
    geo: { houseGeo, roofGeo, hotelGeo, tileGeo, dieGeo },
    mat: { houseMat, roofMat, hotelMat },
    /**
     * Camera as spherical coordinates, so dragging is two numbers.
     *
     * `base` is where the board has been turned to and `angle` is where it is
     * this frame — the difference is the sway. Zero means looking down the +z
     * axis, which is the one angle where every name on the board reads the right
     * way up, so it is where the board starts and what the sway returns to.
     */
    view: {
      base: 0,
      angle: 0,
      tilt: 0.94,
      far: span(side),
      squeeze: 1,
      phase: 0,
      target: new T.Vector3(0, 0, 0),
    },
    drag: null,
    throwing: null,
    rollSeen: -1,
    walks: [],
    flashes: [],
    mapId: mono.map.id,
    seats: mono.players.length,
    raf: 0,
    ctx,
    // Set before the scene existed, so it survives the board being rebuilt for
    // a theme change: whoever asked to be told about a tap still is.
    onPick: pickHandler,
  };

  fitCamera();
  attachPointer();
  observeSize();

  world.raf = requestAnimationFrame(frame);
  return world;
}

// ---------------------------------------------------------------------------
// Pawns
// ---------------------------------------------------------------------------

function makePawn(player, ctx) {
  const { T, scene, theme } = world;
  const hue = hueFor(player.id);
  const colour = new T.Color().setHSL(hue / 360, 0.6, theme.dark ? 0.55 : 0.46);
  const group = new T.Group();

  const body = new T.Mesh(
    new T.CylinderGeometry(0.1, 0.24, PAWN_HEIGHT * 0.62, 20),
    new T.MeshStandardMaterial({ color: colour, roughness: 0.35, metalness: 0.08 }),
  );
  body.position.y = PAWN_HEIGHT * 0.31;
  body.castShadow = true;
  group.add(body);

  const head = new T.Mesh(
    new T.SphereGeometry(0.15, 20, 16),
    new T.MeshStandardMaterial({ color: colour, roughness: 0.28, metalness: 0.1 }),
  );
  head.position.y = PAWN_HEIGHT * 0.72;
  head.castShadow = true;
  group.add(head);

  // The name, on a card above the piece. Always facing you, whichever way the
  // board has been turned — the point of it is to be read.
  const badge = new T.Sprite(
    new T.SpriteMaterial({
      map: (() => {
        const tex = new T.CanvasTexture(
          paintBadge(
            { token: player.token, name: nameFor(ctx, player.id) },
            hue,
            theme,
          ),
        );
        tex.colorSpace = T.SRGBColorSpace;
        return tex;
      })(),
      transparent: true,
      depthTest: false,
    }),
  );
  badge.scale.set(1.55, 0.465, 1);
  badge.position.y = PAWN_HEIGHT + 0.42;
  badge.renderOrder = 10;
  group.add(badge);

  scene.add(group);
  return { group, body, head, badge, hue, colour, pos: player.pos, name: nameFor(ctx, player.id) };
}

function nameFor(ctx, id) {
  return ctx.state?.players?.find((p) => p.id === id)?.nickname ?? "…";
}

/** Where a pawn stands, nudged off-centre so two on one square do not overlap. */
function pawnSpot(index, seat, count) {
  const at = squarePlace(index, world.total);
  if (count <= 1) return { x: at.x, z: at.z };
  const ring = 0.2;
  const angle = (seat / count) * Math.PI * 2;
  return { x: at.x + Math.cos(angle) * ring, z: at.z + Math.sin(angle) * ring };
}

// ---------------------------------------------------------------------------
// The camera
// ---------------------------------------------------------------------------

/**
 * Point the camera. Called every frame while the board drifts, so it does no
 * more than three trigonometric functions and a lookAt.
 */
function placeCamera() {
  if (!world) return;
  const { camera, view } = world;
  const back = view.far * view.squeeze;
  camera.position.set(
    Math.sin(view.angle) * Math.cos(view.tilt) * back,
    Math.sin(view.tilt) * back,
    Math.cos(view.angle) * Math.cos(view.tilt) * back,
  );
  camera.lookAt(view.target);
}

/**
 * Match the drawing buffer to the panel. Called on resize, not on every frame:
 * `setSize` reallocates, and reallocating sixty times a second is how a board
 * that is standing still empties a battery.
 */
function fitCamera() {
  if (!world) return;
  const { camera, view, renderer } = world;
  const box = boardHost();
  const w = box.clientWidth || 640;
  const h = box.clientHeight || 480;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // A tall narrow panel needs the camera further back or the board runs off the
  // sides. The board is square, so the shortfall is whichever axis is smaller.
  view.squeeze = Math.max(1, 1.16 / Math.min(1.16, w / h));
  camera.updateProjectionMatrix();
  placeCamera();
}

function observeSize() {
  const ro = new ResizeObserver(() => fitCamera());
  ro.observe(boardHost());
  world.resizeWatch = ro;
}

/**
 * Drag to turn the board, wheel to lean in.
 *
 * Written here rather than vendored: three.js ships an OrbitControls with
 * damping, panning, touch gestures and key bindings, and this needs two angles
 * and a distance. Sixty lines against another file to keep in step.
 */
function attachPointer() {
  const canvas = world.renderer.domElement;

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    world.drag = {
      x: e.clientX,
      y: e.clientY,
      moved: 0,
      angle: world.view.base,
      tilt: world.view.tilt,
    };
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!world.drag) return;
    const dx = e.clientX - world.drag.x;
    const dy = e.clientY - world.drag.y;
    world.drag.moved = Math.max(world.drag.moved, Math.abs(dx) + Math.abs(dy));
    world.view.base = world.drag.angle - dx * 0.006;
    world.view.angle = world.view.base;
    // Kept off both poles: straight down loses the board's depth and straight on
    // hides the far row behind the near one.
    world.view.tilt = Math.min(1.42, Math.max(0.28, world.drag.tilt + dy * 0.005));
    placeCamera();
  });

  const release = (e) => {
    if (!world.drag) return;
    const tap = world.drag.moved < 6;
    world.drag = null;
    if (tap) pick(e);
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", () => (world.drag = null));

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const span = world.side;
    world.view.far = Math.min(span * 2.4, Math.max(span * 0.85, world.view.far + e.deltaY * 0.01));
    placeCamera();
  }, { passive: false });
}

/** A tap on a square selects it, exactly as clicking one on the flat board does. */
function pick(e) {
  const { T, camera, tiles, renderer, ctx } = world;
  const rect = renderer.domElement.getBoundingClientRect();
  const point = new T.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const ray = new T.Raycaster();
  ray.setFromCamera(point, camera);
  const hit = ray.intersectObjects(tiles.map((t) => t.mesh), false)[0];
  if (!hit) return;
  const index = hit.object.userData.index;
  const local = ctx.local;
  local.monoSelected = local.monoSelected === index ? null : index;
  flashSquare(index, 0.5);
  world.onPick?.();
}

// ---------------------------------------------------------------------------
// Reacting to a snapshot
// ---------------------------------------------------------------------------

/**
 * Bring the world in line with the board that just arrived.
 *
 * Everything that moved is animated *from where it was drawn* rather than set
 * to where it now is — that difference is the whole reason this file exists.
 */
export function updateBoard(ctx, mono) {
  if (!world || world.mapId !== mono.map.id) return;
  world.ctx = ctx;

  // --- who is where ---
  const live = mono.players.filter((p) => !p.bankrupt);
  for (const player of live) {
    let pawn = world.pawns.get(player.id);
    if (!pawn) {
      pawn = makePawn(player, ctx);
      world.pawns.set(player.id, pawn);
      const seat = live.indexOf(player);
      const spot = pawnSpot(player.pos, seat, live.length);
      pawn.group.position.set(spot.x, BASE_DROP + PAWN_LIFT, spot.z);
      pawn.pos = player.pos;
      pawn.cash = player.cash;
      continue;
    }
    if (pawn.pos !== player.pos) {
      walk(pawn, pawn.pos, player.pos, live.indexOf(player), live.length);
    }
    pawn.pos = player.pos;
    // Money moving is most of what happens in this game and none of it was
    // visible on the board: rent, salary, tax and a purchase all used to be a
    // line in the feed and a different number in the sidebar. The difference
    // floats up off whoever it happened to, so you see it happen to them.
    if (pawn.cash !== undefined && player.cash !== pawn.cash) {
      floatMoney(pawn, player.cash - pawn.cash, mono);
    }
    pawn.cash = player.cash;
    // Somebody in jail lies on their side. It reads at a glance from any angle,
    // which a badge saying so does not.
    pawn.group.rotation.z = player.inJail ? 0.9 : 0;
  }

  // Whose turn it is, on the board rather than only in the banner.
  markTurn(mono.turnId);
  for (const [id, pawn] of world.pawns) {
    if (live.some((p) => p.id === id)) continue;
    world.scene.remove(pawn.group);
    world.pawns.delete(id);
  }

  // --- what has been bought and built ---
  for (const tile of world.tiles) {
    const space = mono.spaces[tile.space.i];
    const owned = space.ownerId ?? null;
    const mortgaged = Boolean(space.mortgaged);
    if (owned !== tile.ownerId || mortgaged !== tile.mortgaged) {
      const changedHands = owned !== tile.ownerId;
      tile.ownerId = owned;
      tile.mortgaged = mortgaged;
      // The owner's colour goes on the sides of the square, not underneath it: a
      // slab beneath a tile is a two-millimetre rim nobody sees, and the sides
      // are what a board seen from a chair is mostly made of. Owned squares also
      // stand very slightly taller, which reads even in a screenshot.
      paintOwner(tile);
      if (changedHands && owned) flashSquare(space.i, 1);
    }
    const level = space.level ?? 0;
    if (level !== tile.level) {
      rebuildHouses(tile, level);
      tile.level = level;
    }
  }

  // --- the throw ---
  throwDice(mono);
}

/**
 * A number that floats up off a player.
 *
 * Painted rather than tabulated because the amount is different every time, and
 * a sprite because it has to be readable from whatever angle the board has been
 * turned to. Green up, red down, and no explanation of why — the feed says why,
 * this says how much and to whom.
 */
function floatMoney(pawn, delta, mono) {
  if (!delta || !motionWanted()) return;
  const { T, scene, theme } = world;
  const up = delta > 0;
  const text = `${up ? "+" : "−"}${formatMoney(Math.abs(delta), mono.map.money.unit)}`;

  const w = 256;
  const h = 96;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "800 52px system-ui, 'Segoe UI', sans-serif";
  // Outlined rather than plated: over a board this busy a solid background is
  // another card in the way, and a stroke reads on the tiles and on the felt.
  g.lineWidth = 9;
  g.strokeStyle = theme.dark ? "rgba(10,14,20,0.92)" : "rgba(255,255,255,0.95)";
  g.strokeText(text, w / 2, h / 2);
  g.fillStyle = up ? "#3fbf6a" : "#e2564a";
  g.fillText(text, w / 2, h / 2);

  const tex = new T.CanvasTexture(canvas);
  tex.colorSpace = T.SRGBColorSpace;
  const sprite = new T.Sprite(
    new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false }),
  );
  sprite.scale.set(1.5, 0.56, 1);
  sprite.renderOrder = 20;
  sprite.position.copy(pawn.group.position);
  sprite.position.y += PAWN_HEIGHT + 0.7;
  scene.add(sprite);

  world.flashes.push({ kind: "float", node: sprite, t: 0, dur: 1250, from: sprite.position.y });
  if (up) blip({ at: 0, freq: 780, dur: 0.12, gain: 0.05, type: "triangle", slideTo: 1120 });
  else blip({ at: 0, freq: 320, dur: 0.16, gain: 0.05, type: "sawtooth", slideTo: 190 });
}

/**
 * A ring under whoever's turn it is.
 *
 * One ring moved about rather than one per player: only one person is ever in
 * turn, and a board with eight rings on it is a board with none.
 */
function markTurn(turnId) {
  const { T, scene } = world;
  if (!world.turnRing) {
    const ring = new T.Mesh(
      new T.RingGeometry(0.3, 0.4, 40),
      new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    scene.add(ring);
    world.turnRing = ring;
  }
  const pawn = turnId ? world.pawns.get(turnId) : null;
  world.turnRing.visible = Boolean(pawn);
  if (!pawn) return;
  world.turnRing.material.color = new T.Color().setHSL(
    pawn.hue / 360,
    0.7,
    world.theme.dark ? 0.62 : 0.48,
  );
  world.turnFor = turnId;
}

/**
 * Show who owns a square, on the square.
 *
 * A mortgaged square keeps its owner's colour but loses most of the saturation:
 * it is still theirs and it still collects nothing, and "greyed out" is the one
 * visual idiom for that which needs no explaining.
 */
function paintOwner(tile) {
  const { T, theme } = world;
  if (!tile.ownerId) {
    tile.sideMat.color = new T.Color(theme.tile);
    tile.baseY = BASE_DROP + TILE_HEIGHT / 2;
    settleTile(tile);
    return;
  }
  const hue = hueFor(tile.ownerId);
  tile.sideMat.color = new T.Color().setHSL(
    hue / 360,
    tile.mortgaged ? 0.12 : 0.66,
    theme.dark ? (tile.mortgaged ? 0.3 : 0.42) : (tile.mortgaged ? 0.62 : 0.52),
  );
  tile.baseY = BASE_DROP + TILE_HEIGHT / 2 + (tile.mortgaged ? 0 : 0.035);
  settleTile(tile);
}

/** Put a square and whatever is built on it at its resting height. */
function settleTile(tile) {
  tile.mesh.position.y = tile.baseY;
  tile.buildings.position.y = tile.baseY + TILE_HEIGHT / 2;
}

/** Houses go up, and go up visibly: each one grows out of the ground. */
function rebuildHouses(tile, level) {
  const { T, geo, mat } = world;
  tile.buildings.clear();
  if (!level) return;
  if (level > 4) {
    const hotel = new T.Mesh(geo.hotelGeo, mat.hotelMat);
    hotel.position.set(0, 0.1, -0.28);
    hotel.castShadow = true;
    tile.buildings.add(hotel);
  } else {
    for (let n = 0; n < level; n++) {
      const house = new T.Group();
      const box = new T.Mesh(geo.houseGeo, mat.houseMat);
      box.position.y = 0.075;
      box.castShadow = true;
      const roof = new T.Mesh(geo.roofGeo, mat.roofMat);
      roof.position.y = 0.21;
      roof.rotation.y = Math.PI / 4;
      roof.castShadow = true;
      house.add(box, roof);
      house.position.set(-0.27 + n * 0.19, 0, -0.28);
      tile.buildings.add(house);
    }
  }
  // The newest one arrives rather than appearing.
  const last = tile.buildings.children[tile.buildings.children.length - 1];
  if (last && motionWanted()) {
    last.scale.set(0.01, 0.01, 0.01);
    world.flashes.push({ kind: "grow", node: last, t: 0, dur: 420 });
  }
  flashSquare(tile.space.i, 0.7);
}

/** A square lights up: bought, built on, landed on. */
function flashSquare(index, strength) {
  if (!world) return;
  const tile = world.tiles[index];
  if (!tile) return;
  world.flashes.push({ kind: "lift", tile, t: 0, dur: 520, strength });
}

/**
 * Walk a pawn from one square to the next, one square at a time.
 *
 * The long way round is deliberate: it is what tells you a six is a six without
 * reading the number, and it is what makes passing Xuất phát something you see
 * rather than something the feed mentions. A jump that is not a walk — sent to
 * jail, a card that moves you across the board — arcs straight there instead,
 * because eleven hops backwards would be a lie about what happened.
 */
function walk(pawn, from, to, seat, count) {
  const total = world.total;
  const steps = [];
  const forward = (to - from + total) % total;
  if (!motionWanted()) {
    const spot = pawnSpot(to, seat, count);
    pawn.group.position.set(spot.x, BASE_DROP + PAWN_LIFT, spot.z);
    return;
  }
  if (forward > 0 && forward <= 12) {
    for (let n = 1; n <= forward; n++) steps.push((from + n) % total);
  } else {
    steps.push(to);
  }
  world.walks.push({
    pawn,
    steps,
    seat,
    count,
    at: 0,
    t: 0,
    dur: steps.length === 1 ? 620 : HOP_MS,
    from: { x: pawn.group.position.x, z: pawn.group.position.z },
    arc: steps.length === 1,
  });
}

/**
 * Throw the dice into the middle of the board.
 *
 * The first sight of a game takes the tally as a baseline and animates nothing:
 * somebody who joins on turn forty should not watch thirty-nine throws
 * re-enacted. After that every roll is thrown, including one that lands the same
 * as the last — which is why the server counts throws rather than the client
 * comparing faces.
 */
function throwDice(mono) {
  if (world.rollSeen === -1) {
    world.rollSeen = mono.rollNo;
    settleDice(mono.dice);
    return;
  }
  if (!mono.dice || mono.rollNo === world.rollSeen) return;
  world.rollSeen = mono.rollNo;
  if (!motionWanted()) {
    settleDice(mono.dice);
    return;
  }

  const { T } = world;
  // Thrown from over the near corner, across the middle: the arc reads as a
  // throw rather than as two cubes materialising.
  const spread = 0.75;
  world.throwing = {
    t: 0,
    dur: THROW_MS,
    faces: mono.dice,
    legs: mono.dice.map((face, n) => ({
      face,
      from: new T.Vector3(-1.4 + n * 0.8, 4.6, 4.2 + n * 0.5),
      to: new T.Vector3((n - 0.5) * spread * 2, BASE_DROP + TILE_HEIGHT + DIE_SIZE / 2, 0.6),
      spin: new T.Vector3(
        6 + Math.random() * 7,
        5 + Math.random() * 6,
        7 + Math.random() * 6,
      ),
      land: faceUpTurned(T, face),
    })),
  };
  world.dice.forEach((die) => (die.visible = true));
  rattle();
}

/** Dice already at rest, for a board that was in progress when you arrived. */
function settleDice(faces) {
  if (!faces) {
    world.dice.forEach((die) => (die.visible = false));
    return;
  }
  const { T } = world;
  world.throwing = null;
  world.dice.forEach((die, n) => {
    die.visible = true;
    die.position.set((n - 0.5) * 1.5, BASE_DROP + TILE_HEIGHT + DIE_SIZE / 2, 0.6);
    die.quaternion.copy(faceUpTurned(T, faces[n]));
  });
}

// ---------------------------------------------------------------------------
// Noises
// ---------------------------------------------------------------------------

function rattle() {
  if (!motionWanted()) return;
  for (let n = 0; n < 5; n++) {
    noise({ at: n * 0.06 + 0.35, dur: 0.05, gain: 0.05, freq: 2600, q: 0.9 });
  }
}

function thud() {
  if (!motionWanted()) return;
  noise({ at: 0, dur: 0.14, gain: 0.16, freq: 420, q: 1.1 });
  blip({ at: 0.02, freq: 180, dur: 0.16, gain: 0.08, type: "sine" });
}

function step() {
  if (!motionWanted()) return;
  blip({ at: 0, freq: 520, dur: 0.05, gain: 0.03, type: "triangle" });
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

let last = 0;

function frame(now) {
  if (!world) return;
  world.raf = requestAnimationFrame(frame);
  const dt = last ? Math.min(64, now - last) : 16;
  last = now;

  advanceWalks(dt);
  advanceThrow(dt);
  advanceFlashes(dt);
  followTurn(dt);

  // A board that never moves looks like a screenshot. A sway rather than a
  // rotation: a board that turns slowly and never comes back is a board whose
  // names are upside down by the end of the game, and the whole reason this
  // angle is the default is that from here every name reads.
  if (motionWanted() && !world.drag) {
    world.view.phase += dt;
    world.view.angle = world.view.base + Math.sin(world.view.phase * 0.00028) * 0.075;
    placeCamera();
  }

  world.renderer.render(world.scene, world.camera);
}

function advanceWalks(dt) {
  for (let n = world.walks.length - 1; n >= 0; n--) {
    const walk = world.walks[n];
    walk.t += dt;
    const leg = Math.min(1, walk.t / walk.dur);
    const target = pawnSpot(walk.steps[walk.at], walk.seat, walk.count);
    const eased = leg * leg * (3 - 2 * leg);
    const x = walk.from.x + (target.x - walk.from.x) * eased;
    const z = walk.from.z + (target.z - walk.from.z) * eased;
    // A hop, not a slide: the height is a parabola over the step, taller on the
    // single long arc that a card or a trip to jail makes.
    const lift = Math.sin(leg * Math.PI) * (walk.arc ? 1.9 : 0.34);
    walk.pawn.group.position.set(x, BASE_DROP + PAWN_LIFT + lift, z);
    // Squash on landing. Two frames of it is the difference between a piece
    // being put down and a piece stopping in mid-air.
    const squash = leg > 0.86 ? 1 - Math.sin((leg - 0.86) / 0.14 * Math.PI) * 0.16 : 1;
    walk.pawn.group.scale.set(2 - squash, squash, 2 - squash);

    if (leg < 1) continue;
    walk.pawn.group.scale.set(1, 1, 1);
    walk.at++;
    walk.from = { x: target.x, z: target.z };
    walk.t = 0;
    if (walk.at < walk.steps.length) {
      step();
      continue;
    }
    flashSquare(walk.steps[walk.steps.length - 1], 1);
    thud();
    world.walks.splice(n, 1);
  }
}

function advanceThrow(dt) {
  const roll = world.throwing;
  if (!roll) return;
  roll.t += dt;
  const p = Math.min(1, roll.t / roll.dur);

  world.dice.forEach((die, n) => {
    const leg = roll.legs[n];
    // Travel eases out; the height is an arc with a bounce at the end, so the
    // dice hit the board, jump a little and settle.
    const travel = 1 - Math.pow(1 - p, 2.4);
    die.position.lerpVectors(leg.from, leg.to, travel);
    const bounce = p < 0.72
      ? Math.sin(p / 0.72 * Math.PI) * 1.5
      : Math.abs(Math.sin((p - 0.72) / 0.28 * Math.PI * 2)) * 0.42 * (1 - (p - 0.72) / 0.28);
    die.position.y = leg.to.y + bounce;

    if (p < 0.78) {
      die.rotation.x += leg.spin.x * dt * 0.001;
      die.rotation.y += leg.spin.y * dt * 0.001;
      die.rotation.z += leg.spin.z * dt * 0.001;
    } else {
      // The last fifth is a slerp onto the face the server rolled. Physics that
      // lands on the right number by accident is physics nobody can trust.
      const settle = (p - 0.78) / 0.22;
      die.quaternion.slerp(leg.land, Math.min(1, settle * settle * 0.5));
      if (p >= 1) die.quaternion.copy(leg.land);
    }
  });

  if (p < 1) return;
  world.throwing = null;
  thud();
  // The ring goes out from between the dice.
  world.pulse.position.x = 0;
  world.pulse.position.z = 0.6;
  world.flashes.push({ kind: "pulse", t: 0, dur: 620 });
}

function advanceFlashes(dt) {
  for (let n = world.flashes.length - 1; n >= 0; n--) {
    const fx = world.flashes[n];
    fx.t += dt;
    const p = Math.min(1, fx.t / fx.dur);

    if (fx.kind === "lift") {
      // The square rises and comes back. Cheap, readable, and it does not move
      // anything a player might be trying to click.
      const lift = Math.sin(p * Math.PI) * 0.14 * (fx.strength ?? 1);
      fx.tile.mesh.position.y = fx.tile.baseY + lift;
      fx.tile.buildings.position.y = fx.tile.baseY + TILE_HEIGHT / 2 + lift;
    } else if (fx.kind === "pulse") {
      world.pulse.material.opacity = (1 - p) * 0.55;
      const size = 0.6 + p * 3.4;
      world.pulse.scale.set(size, size, size);
    } else if (fx.kind === "grow") {
      const spring = 1 - Math.pow(1 - p, 3);
      const over = 1 + Math.sin(p * Math.PI) * 0.18;
      fx.node.scale.setScalar(spring * over);
    } else if (fx.kind === "float") {
      // Up and away, holding full opacity for the first half so the number can
      // actually be read before it starts to go.
      fx.node.position.y = fx.from + p * 1.15;
      fx.node.material.opacity = p < 0.5 ? 1 : 1 - (p - 0.5) / 0.5;
    }

    if (p < 1) continue;
    if (fx.kind === "pulse") world.pulse.material.opacity = 0;
    if (fx.kind === "grow") fx.node.scale.setScalar(1);
    if (fx.kind === "float") {
      world.scene.remove(fx.node);
      fx.node.material.map?.dispose();
      fx.node.material.dispose();
    }
    world.flashes.splice(n, 1);
  }
}

/**
 * Keep the turn ring under the piece it belongs to, and breathing.
 *
 * Followed every frame rather than placed when the turn changes, because the
 * piece it is under spends a second and a half of every turn walking.
 */
function followTurn(dt) {
  const ring = world.turnRing;
  if (!ring?.visible) return;
  const pawn = world.pawns.get(world.turnFor);
  if (!pawn) {
    ring.visible = false;
    return;
  }
  ring.position.set(
    pawn.group.position.x,
    BASE_DROP + TILE_HEIGHT + 0.015,
    pawn.group.position.z,
  );
  world.ringPhase = (world.ringPhase ?? 0) + dt;
  const breath = motionWanted() ? 1 + Math.sin(world.ringPhase * 0.004) * 0.12 : 1;
  ring.scale.setScalar(breath);
  ring.material.opacity = motionWanted() ? 0.6 + Math.sin(world.ringPhase * 0.004) * 0.25 : 0.8;
}

// ---------------------------------------------------------------------------
// Coming and going
// ---------------------------------------------------------------------------

/** The in-flight build, so a snapshot arriving mid-import does not start a second. */
let building = null;
/** Set once, when the 3D board has proved it cannot run here. */
let failed = false;
/** Told when a square is tapped, and when the board gives up. */
let pickHandler = null;
let failHandler = null;

/**
 * Make sure there is a board, and that it is this board.
 *
 * Called on every snapshot and cheap on all but the first: the scene is built
 * once per map. Changing map — a new game on a different board — tears the old
 * one down rather than trying to reconcile forty squares that are now somewhere
 * else entirely.
 */
export function ensureBoard(ctx, mono) {
  if (failed) return;
  if (world && world.mapId === mono.map.id) {
    updateBoard(ctx, mono);
    return;
  }
  if (world) dropBoard();
  if (building) return;
  building = build(ctx, mono)
    .then(() => {
      building = null;
      updateBoard(ctx, mono);
      fitCamera();
    })
    .catch((err) => {
      building = null;
      failed = true;
      // Not a thrown error and not a toast: a board that cannot do 3D is a board
      // that does 2D, which is a whole game. The console is for whoever is
      // debugging it, and the caller switches back without asking anybody.
      console.warn("3D board unavailable, falling back to the flat board", err);
      failHandler?.();
    });
}

/**
 * Whether the 3D board has given up.
 *
 * Asked by the caller before it offers the switch. Sticky on purpose: a machine
 * that could not build the scene once will not build it on the next snapshot
 * either, and retrying every second would be a stutter rather than a recovery.
 */
export function boardFailed() {
  return failed;
}

/** Called when a square is tapped, so the page can redraw the panels around it. */
export function onPick(fn) {
  pickHandler = fn;
  if (world) world.onPick = fn;
}

/** Called if the board turns out to be impossible here. */
export function onFail(fn) {
  failHandler = fn;
}

export function dropBoard() {
  if (!world) return;
  cancelAnimationFrame(world.raf);
  world.resizeWatch?.disconnect();
  world.renderer.dispose();
  world.renderer.domElement.remove();
  world.scene.traverse((node) => {
    node.geometry?.dispose?.();
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    for (const mat of mats) {
      mat?.map?.dispose?.();
      mat?.dispose?.();
    }
  });
  world = null;
  last = 0;
}

/**
 * The theme changed under us.
 *
 * Every texture has the surface colour and the ink colour painted into it, so
 * there is no cheap way to re-tint forty canvases: the honest answer is to build
 * the scene again. It happens when somebody presses the theme button, which is
 * not often and not during a throw.
 */
export function repaintBoard(ctx, mono) {
  if (!world) return;
  dropBoard();
  ensureBoard(ctx, mono);
}
