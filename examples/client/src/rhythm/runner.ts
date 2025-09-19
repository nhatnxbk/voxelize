import * as VOXELIZE from "@voxelize/core";

import { NotePlacement, RhythmCourse, RhythmCourseMode } from "./course-builder";

export type RhythmRunnerState = "idle" | "ready" | "running" | "finished";

export type RhythmRunnerOptions = {
  controls: VOXELIZE.RigidControls;
  world: VOXELIZE.World;
};

const CLEAR_TYPE = 0;
const EPSILON = 1e-3;
const END_PADDING = 2.5; // seconds after last note before finishing
const JUMP_WINDOW = 0.35; // seconds for jump apex smoothing

function dedupeUpdates(updates: VOXELIZE.BlockUpdate[]) {
  const map = new Map<string, VOXELIZE.BlockUpdate>();
  updates.forEach((update) => {
    const key = `${update.vx},${update.vy},${update.vz}`;
    map.set(key, update);
  });
  return Array.from(map.values());
}

export class RhythmRunner {
  private state: RhythmRunnerState = "idle";
  private currentCourse: RhythmCourse | null = null;
  private stagedBlocks: VOXELIZE.BlockUpdate[] = [];
  private audio: HTMLAudioElement | null = null;
  private startTimestamp = 0;
  private lastAudioTime = 0;
  private onFinishCallbacks: Array<() => void> = [];

  constructor(private readonly options: RhythmRunnerOptions) {}

  get runnerState() {
    return this.state;
  }

  get currentAudioTime() {
    return this.lastAudioTime;
  }

  get courseMode(): RhythmCourseMode | null {
    return this.currentCourse?.mode ?? null;
  }

  get activeCourse() {
    return this.currentCourse;
  }

  setAudio(audio: HTMLAudioElement | null) {
    this.audio = audio;
  }

  onFinish(callback: () => void) {
    this.onFinishCallbacks.push(callback);
  }

  applyCourse(course: RhythmCourse) {
    this.clearCourse();
    this.currentCourse = course;
    this.stagedBlocks = dedupeUpdates(course.blockPlacements);
    if (this.stagedBlocks.length) {
      this.options.world.updateVoxels(this.stagedBlocks);
    }

    this.state = "ready";
  }

  clearCourse() {
    if (this.stagedBlocks.length) {
      const removals = this.stagedBlocks.map((block) => ({
        vx: block.vx,
        vy: block.vy,
        vz: block.vz,
        type: CLEAR_TYPE,
      }));
      this.options.world.updateVoxels(removals);
    }
    this.stagedBlocks = [];
    this.currentCourse = null;
    this.stop();
    this.state = "idle";
  }

  start() {
    if (!this.currentCourse) return false;
    if (!this.audio) return false;

    this.resetPlayerPosition(0);
    this.options.controls.resetMovements();

    try {
      this.audio.currentTime = 0;
    } catch (e) {
      // ignore if unable to reset buffered audio
    }

    this.startTimestamp = performance.now();
    this.lastAudioTime = 0;
    const playPromise = this.audio.play();
    if (playPromise) {
      playPromise.catch(() => {
        // Playback might fail (e.g. without user gesture). We still proceed but rely on manual timing.
      });
    }

    this.state = "running";
    return true;
  }

  stop() {
    if (this.audio && !this.audio.paused) {
      this.audio.pause();
    }
    this.state = this.currentCourse ? "ready" : "idle";
  }

  update(_delta: number) {
    if (this.state !== "running" || !this.currentCourse) return;

    const audioTime = this.audio && !Number.isNaN(this.audio.currentTime)
      ? this.audio.currentTime
      : (performance.now() - this.startTimestamp) / 1000;

    if (audioTime + EPSILON < this.lastAudioTime) {
      // audio jumped backwards, reset baseline to avoid jitter
      this.startTimestamp = performance.now() - audioTime * 1000;
    }
    this.lastAudioTime = audioTime;

    const courseDuration = this.currentCourse.duration + END_PADDING;
    const clampedTime = Math.min(audioTime, courseDuration);

    this.resetPlayerPosition(clampedTime);

    if (clampedTime + EPSILON >= courseDuration) {
      this.finish();
    }
  }

  getActivePlacements(window = 0.2) {
    if (!this.currentCourse) return [] as NotePlacement[];
    const audioTime = this.audio ? this.audio.currentTime : 0;
    return this.currentCourse.placements.filter((placement) => {
      return Math.abs(placement.note.time - audioTime) <= window;
    });
  }

  private finish() {
    if (this.state !== "running") return;
    this.stop();
    this.state = "finished";
    this.onFinishCallbacks.forEach((callback) => callback());
  }

  private resetPlayerPosition(time: number) {
    if (!this.currentCourse) return;

    const { controls } = this.options;
    const { body } = controls;
    const bodyHeight = controls.options.bodyHeight ?? 1.8;
    const feetBase =
      this.currentCourse.placements[0]?.contactFeetY ??
      this.currentCourse.baseVoxel[1] + 1;

    let feetY = feetBase;
    const positionZ = this.currentCourse.origin.z + time * this.currentCourse.moveSpeed;
    const x = this.currentCourse.origin.x;

    if (this.currentCourse.mode === "platform") {
      this.currentCourse.placements.forEach((placement) => {
        if (placement.behaviour !== "jump") return;
        const diff = Math.abs(time - placement.note.time);
        if (diff <= JUMP_WINDOW) {
          const t = 1 - diff / JUMP_WINDOW;
          const jumpOffset = Math.sin(t * Math.PI) * placement.jumpHeight;
          feetY = Math.max(feetY, placement.contactFeetY + jumpOffset);
        }
      });
    }

    const centerY = feetY + bodyHeight / 2;

    body.setPosition([x, centerY, positionZ]);
    body.velocity = [0, 0, 0];
    body.forces = [0, 0, 0];
    body.impulses = [0, 0, 0];
    body.resting = [0, 0, 0];

    controls.lookAt(x, centerY, positionZ + 5);
  }
}
