console.log("main.js loaded");

import { FilesetResolver, HandLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18";

// Portrait game (matches your background exactly: 2:3)
const W = 800;
const H = 1200;

// ---------- Hand tracking state (shared with Phaser) ----------
const handState = {
  ready: false,
  hasHand: false,
  cursorX: W / 2,
  cursorY: H / 2,
  pinching: false,
  smoothX: W / 2,
  smoothY: H / 2,
};

// Pinch stability counters
let pinchOnFrames = 0;
let pinchOffFrames = 0;

// ---------- Camera + MediaPipe setup ----------
async function setupHandTracking() {
  const video = document.getElementById("cam");

  // Ask for webcam
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();

  const fileset = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
  );

  const landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    },
    runningMode: "VIDEO",
    numHands: 1,
  });

  handState.ready = true;

  let lastTime = -1;

  function tick() {
    const now = performance.now();
    if (video.readyState >= 2 && now !== lastTime) {
      lastTime = now;

      const res = landmarker.detectForVideo(video, now);

      if (res.landmarks && res.landmarks.length > 0) {
        handState.hasHand = true;
        const lm = res.landmarks[0];

        // Index fingertip = landmark 8, thumb tip = landmark 4
        const indexTip = lm[8];
        const thumbTip = lm[4];

        // Convert normalized [0..1] -> game coords (mirror X for selfie feel)
        const targetX = (1 - indexTip.x) * W;
        const targetY = indexTip.y * H;

        // smoothing factor (0.15–0.3 feels good)
        const SMOOTH = 0.2;

        handState.smoothX += (targetX - handState.smoothX) * SMOOTH;
        handState.smoothY += (targetY - handState.smoothY) * SMOOTH;

        handState.cursorX = handState.smoothX;
        handState.cursorY = handState.smoothY;

        // --- Pinch detection (normalized by hand size + debounced ON/OFF) ---
        const dx = indexTip.x - thumbTip.x;
        const dy = indexTip.y - thumbTip.y;
        const dist = Math.hypot(dx, dy);

        // Hand size proxy (wrist -> middle MCP) to normalize distances
        const wrist = lm[0];
        const midMcp = lm[9];
        const handSize = Math.max(
          0.001,
          Math.hypot(midMcp.x - wrist.x, midMcp.y - wrist.y)
        );

        const pinchRatio = dist / handSize;

        // Thresholds for pinchRatio (tune if needed)
        const PINCH_ON = 0.40;   // lower => stricter pinch
        const PINCH_OFF = 0.55;  // higher => more forgiving hold

        if (pinchRatio < PINCH_ON) {
          pinchOnFrames++;
          pinchOffFrames = 0;
        } else if (pinchRatio > PINCH_OFF) {
          pinchOffFrames++;
          pinchOnFrames = 0;
        } else {
          // In hysteresis band: keep state, reset counters
          pinchOnFrames = 0;
          pinchOffFrames = 0;
        }

        if (!handState.pinching && pinchOnFrames >= 3) {
          handState.pinching = true;
          pinchOnFrames = 0;
        }

        if (handState.pinching && pinchOffFrames >= 4) {
          handState.pinching = false;
          pinchOffFrames = 0;
        }
      } else {
        handState.hasHand = false;
        handState.pinching = false;
        pinchOnFrames = 0;
        pinchOffFrames = 0;
      }
    }

    requestAnimationFrame(tick);
  }

  tick();
}

// ---------- Phaser game ----------
class MainScene extends Phaser.Scene {
  constructor() {
    super("main");
    this.held = null;
    this.releaseGrace = 0;
  }

  preload() {
    const asset = (p) => new URL(p, import.meta.url).toString();

    this.load.image("bg", asset("../assets/witch_room.png"));

    // Cauldron frames
    for (let i = 1; i <= 7; i++) {
      this.load.image(`cauldron${i}`, asset(`../assets/cauldron${i}.png`));
    }

    const colors = ["cyan", "purple", "pink", "yellow", "blue", "green", "red"];
    const states = [
      "standing",
      "tip1", "tip2", "tip3",
      "spill1", "spill2", "spill3", "spill4",
    ];

    for (const c of colors) {
      for (const s of states) {
        this.load.image(`${c}_${s}`, asset(`../assets/potions/${c}_${s}.png`));
      }
    }
  }

  create() {
    // Background (CONTAIN)
    const bg = this.add.image(W / 2, H / 2, "bg").setOrigin(0.5);
    const sX = W / bg.width;
    const sY = H / bg.height;
    bg.setScale(Math.min(sX, sY));
    bg.setDepth(-100);

    // Anchors
    this.TABLE_Y = 0.57 * H;

    // Cauldron image
    this.cauldron = this.add.image(0.5 * W, this.TABLE_Y + 10, "cauldron1")
      .setOrigin(0.5)
      .setScale(0.4);

    this.cauldron.isAnimating = false;

    // Shelf slots tuned for your background
    this.SHELF_SLOTS = [
      // top shelf (4)
      [0.2, 0.24, 0.73],
      [0.4, 0.285, 1.1],
      [0.6, 0.26, 1],
      [0.8, 0.25, 0.9],

      // middle shelf (3)
      [0.3, 0.345, 0.85],
      [0.5, 0.375, 1.2],
      [0.7, 0.355, 0.9],
    ];

    const colors = ["cyan", "purple", "pink", "blue", "green", "yellow", "red"];
    const TARGET_H = 180; // tweak this to make potions bigger/smaller overall

    this.potions = [];

    colors.forEach((color, i) => {
      const [xN, yN, scaleMul] = this.SHELF_SLOTS[i];

      const potion = this.add.image(xN * W, yN * H, `${color}_standing`);

      potion.color = color;

      // scale by target height + shelf multiplier
      potion.setScale((TARGET_H / potion.height) * scaleMul);

      // anchor to bottom so it sits on the plank
      potion.setOrigin(0.5, 1);

      // home for returning
      potion.homeX = potion.x;
      potion.homeY = potion.y;

      potion.homeDepth = 5;
      potion.setDepth(potion.homeDepth);

      potion.isAnimating = false;

      this.potions.push(potion);
    });

    // Cursor
    this.cursor = this.add.circle(W / 2, H / 2, 10, 0xffffff).setAlpha(0.9);
    this.cursorRing = this.add.circle(W / 2, H / 2, 18)
      .setStrokeStyle(2, 0xffffff)
      .setAlpha(0.6);
    this.cursor.setDepth(1000);
    this.cursorRing.setDepth(1000);

    // UI
    // this.statusText = this.add.text(16, 14, "Loading hand tracking...", {
    //   color: "#f5e9ff",
    //   fontSize: "16px",
    // });

    // this.pourText = this.add.text(16, 40, "", {
    //   color: "#ffd6ea",
    //   fontSize: "16px",
    // });
  }

  playCauldronAnim() {
    if (!this.cauldron || this.cauldron.isAnimating) return;
    this.cauldron.isAnimating = true;

    let frame = 2;
    const stepMs = 90;

    const step = () => {
      this.cauldron.setTexture(`cauldron${frame}`);
      frame += 1;

      if (frame <= 7) {
        this.time.delayedCall(stepMs, step);
      } else {
        this.time.delayedCall(200, () => {
          this.cauldron.setTexture("cauldron1");
          this.cauldron.isAnimating = false;
        });
      }
    };

    step();
  }

  playPotionSequence(potion) {
    if (!potion || potion.isAnimating) return;

    potion.isAnimating = true;

    const frames = [
      "standing",
      "tip1", "tip2", "tip3",
      "spill1", "spill2", "spill3", "spill4",
    ];

    let index = 0;

    // cauldron in front while spilling (we keep potion behind it)
    this.cauldron.setDepth(50);
    potion.setDepth(40);

    const step = () => {
      potion.setTexture(`${potion.color}_${frames[index]}`);
      index += 1;

      if (index < frames.length) {
        this.time.delayedCall(150, step);
      } else {
        this.time.delayedCall(200, () => {
          potion.setTexture(`${potion.color}_standing`);
          potion.x = potion.homeX;
          potion.y = potion.homeY;

          potion.setDepth(potion.homeDepth);
          this.cauldron.setDepth(0);


          potion.isAnimating = false;

          this.playCauldronAnim();
        });
      }
    };

    step();
  }

  update() {
    // // Status
    // if (!handState.ready) {
    //   this.statusText.setText("Loading hand tracking...");
    //   return;
    // }
    // if (!handState.hasHand) {
    //   this.statusText.setText("Show one hand to the camera");
    //   return;
    // }

    // this.statusText.setText(handState.pinching ? "PINCH" : "Pinch to grab");
    // this.cursor.setFillStyle(handState.pinching ? 0xff8ad8 : 0xffffff);
    // this.cursorRing.setStrokeStyle(2, handState.pinching ? 0xff8ad8 : 0xffffff);

    // Smooth cursor visuals
    this.cursor.x += (handState.cursorX - this.cursor.x) * 0.4;
    this.cursor.y += (handState.cursorY - this.cursor.y) * 0.4;
    this.cursorRing.x += (handState.cursorX - this.cursorRing.x) * 0.2;
    this.cursorRing.y += (handState.cursorY - this.cursorRing.y) * 0.2;

    // If holding potion, follow cursor
    if (this.held) {
      this.held.x = handState.cursorX;
      this.held.y = handState.cursorY;
    }

    // Detect potion hover
    let hoveredPotion = null;
    for (const p of this.potions) {
      if (p.isAnimating) continue;

      if (
        Phaser.Geom.Rectangle.Contains(
          p.getBounds(),
          handState.cursorX,
          handState.cursorY
        )
      ) {
        hoveredPotion = p;
        break;
      }
    }

    // Grab
    if (!this.held && handState.pinching && hoveredPotion) {
      this.held = hoveredPotion;
      this.releaseGrace = 0;
      this.held.setDepth(100);
        // Put it above ALL potions while dragging
      this.held.setDepth(500);

      // Also force display-list ordering (beats “render order” ties)
      this.children.bringToTop(this.held);

    }

    // Release / drop
    if (this.held) {
      if (handState.pinching) {
        this.releaseGrace = 0;
      } else {
        this.releaseGrace += 1;
      }

      if (this.releaseGrace >= 3) {
        const overCauldron = Phaser.Geom.Rectangle.Contains(
          this.cauldron.getBounds(),
          handState.cursorX,
          handState.cursorY
        );

        if (overCauldron) {
          // Snap into position above cauldron
          this.held.x = this.cauldron.x;
          this.held.y = this.cauldron.y - 120;

          this.cauldron.setDepth(200);
          this.held.setDepth(190);


          this.playPotionSequence(this.held);
        } else {
          // Return home
          this.held.x = this.held.homeX;
          this.held.y = this.held.homeY;
        }

        this.held = null;
        this.releaseGrace = 0;
      }
    }
  }
}

const config = {
  type: Phaser.AUTO,
  width: W,
  height: H,
  backgroundColor: "#1b1026",
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [MainScene],
};

new Phaser.Game(config);

// Start tracking
setupHandTracking().catch((err) => {
  console.error(err);
  alert("Camera/hand tracking failed. Open the console for details.");
});
